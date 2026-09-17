import { loadEnvFile } from "node:process";
import { writeFile } from "node:fs/promises";
import { createModelProvider, preflightPlanV2, suggestMappings, suggestRuleDraftV3Detailed, type DataSetV2 } from "@ctd-abpa/core";
import { TargetTemplateVersionSchema, type DataType, type ProcessPlanV3, type RuleDraft, type TargetTemplateVersion } from "@ctd-abpa/types";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

type ArtifactContext = Array<{ id: string; sheets: Array<{ id: string; headerRow: number; columns: Array<{ index: number; header: string; inferredTypes: string[] }> }> }>;
interface Scenario { id: string; category: "mapping" | "filter" | "join" | "calculation" | "output"; instruction: string; run(): Promise<{ repairRounds: number; model: string; latencyMs?: number; totalTokens?: number; draft?: RuleDraft }>; }
interface CaseResult { id: string; category: Scenario["category"]; round: number; passed: boolean; firstRound: boolean; repairRounds?: number; model?: string; latencyMs?: number; totalTokens?: number; error?: string; }

const providerId = "siliconflow" as const;
const typeMap: Record<string, DataType> = { string: "text", text: "text", integer: "integer", number: "decimal", decimal: "decimal", boolean: "boolean", date: "date", datetime: "datetime" };
const template = (id: string, columns: Array<{ columnId: string; dataType: DataType }>, sheets = ["result"]): TargetTemplateVersion => TargetTemplateVersionSchema.parse({ id, version: 1, format: "xlsx", sheets: sheets.map((sheetId) => ({ sheetId, name: sheetId, headerRow: 1, columns: columns.map((column) => ({ ...column, header: column.columnId, required: true })) })) });

function bindings(plan: ProcessPlanV3, artifacts: ArtifactContext): Record<string, DataSetV2> {
  return Object.fromEntries(plan.inputs.map((input) => {
    const sheet = artifacts.find((artifact) => artifact.id === input.artifactId)?.sheets.find((item) => item.id === input.sheetId);
    if (!sheet) throw new Error(`输入不存在: ${input.artifactId}/${input.sheetId}`);
    const columns = Object.fromEntries(input.columns.map((column) => {
      const source = sheet.columns[column.sourceIndex];
      return [column.columnId, typeMap[source?.inferredTypes[0] ?? "text"] ?? "text"];
    }));
    return [input.bindingId, { columns, rows: [] } satisfies DataSetV2];
  }));
}

function atoms(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.kind === "compare") return [record];
  return Object.values(record).flatMap((item) => Array.isArray(item) ? item.flatMap(atoms) : atoms(item));
}

function assertDraft(category: Scenario["category"], draft: RuleDraft, artifacts: ArtifactContext, target: TargetTemplateVersion): void {
  if (draft.status !== "proposed" || !draft.plan) throw new Error(`未形成可预演规则: ${draft.status}`);
  preflightPlanV2(draft.plan, bindings(draft.plan, artifacts), target);
  if (draft.requirements.some((item) => item.status !== "satisfied")) throw new Error("存在未落实条件");
  if (category === "filter" && !draft.plan.steps.some((step) => step.operator === "filter" && atoms(step.predicate).length > 0)) throw new Error("缺少有效筛选谓词");
  if (category === "join" && !draft.plan.steps.some((step) => step.operator === "join" && step.cardinality === "many_to_one")) throw new Error("缺少多对一关联");
  if (category === "calculation" && !draft.plan.steps.some((step) => step.operator === "calculate")) throw new Error("缺少确定性计算步骤");
  if (category === "output" && !target.sheets.every((sheet) => draft.plan!.outputs.some((output) => output.sheetId === sheet.sheetId))) throw new Error("目标工作表未完整绑定");
}

function planScenario(category: Exclude<Scenario["category"], "mapping">, id: string, instruction: string, artifacts: ArtifactContext, target: TargetTemplateVersion): Scenario {
  return { id, category, instruction, async run() {
    const result = await suggestRuleDraftV3Detailed({ instruction, artifacts, template: target, ruleRef: { id: `real.${category}.${id}`, version: 1 } }, providerId, createModelProvider(providerId));
    assertDraft(category, result.draft, artifacts, target);
    return { repairRounds: result.repairRounds, model: result.call?.model ?? "local", latencyMs: result.call?.latencyMs, totalTokens: result.call?.usage.totalTokens, draft: result.draft };
  } };
}

const mappingHeaders = ["人员代号", "所属组织", "流程状态", "请假开始", "请假小时数"];
const mappingInstructions = [
  "把标准字段 employeeId 映射到表示员工唯一编号的源列。",
  "请识别哪一列是员工工号，并映射为 employeeId。",
  "人员唯一标识字段需要绑定到标准 employeeId。",
  "在这些表头中找出职工编号列，作为 employeeId。",
  "为 employeeId 提议源字段映射；不确定时请澄清。",
];
const scenarios: Scenario[] = mappingInstructions.map((instruction, index) => ({ id: `mapping-${index + 1}`, category: "mapping", instruction, async run() {
  const result = await suggestMappings({ instruction, headers: mappingHeaders, inferredTypes: Object.fromEntries(mappingHeaders.map((header) => [header, ["string"]])), provider: providerId, modelProvider: createModelProvider(providerId) });
  if (!result.advice.mappings.some((item) => item.standardField === "employeeId" && item.sourceHeader === "人员代号")) throw new Error("employeeId 未正确映射到人员代号");
  return { repairRounds: 0, model: result.call.model, latencyMs: result.call.latencyMs, totalTokens: result.call.usage.totalTokens };
} }));

const source: ArtifactContext = [{ id: "leave-source", sheets: [{ id: "leave-sheet", headerRow: 1, columns: [
  { index: 0, header: "工号", inferredTypes: ["text"] }, { index: 1, header: "姓名", inferredTypes: ["text"] }, { index: 2, header: "部门", inferredTypes: ["text"] }, { index: 3, header: "审批状态", inferredTypes: ["text"] }, { index: 4, header: "开始日期", inferredTypes: ["date"] }, { index: 5, header: "员工类型", inferredTypes: ["text"] }, { index: 6, header: "金额", inferredTypes: ["decimal"] }, { index: 7, header: "小时数", inferredTypes: ["decimal"] }, { index: 8, header: "费率", inferredTypes: ["decimal"] },
] }] }];
const detailTemplate = template("real-detail", [{ columnId: "employee_id", dataType: "text" }]);
[
  "只保留部门为研发，2026年4月份，已审批的记录",
  "筛选部门为销售，日期从2026-05-01至2026-05-31，并且审批通过",
  "只保留工号为E001且已审批的记录",
  "排除临时工的记录",
  "仅保留姓名为张三的记录",
].forEach((instruction, index) => scenarios.push(planScenario("filter", `filter-${index + 1}`, instruction, source, detailTemplate)));

const joinArtifacts: ArtifactContext = [source[0], { id: "employee-master", sheets: [{ id: "master-sheet", headerRow: 1, columns: [
  { index: 0, header: "主数据工号", inferredTypes: ["text"] }, { index: 1, header: "主数据姓名", inferredTypes: ["text"] }, { index: 2, header: "主数据部门", inferredTypes: ["text"] }, { index: 3, header: "岗位", inferredTypes: ["text"] },
] }] }];
[
  "将请假明细按工号关联员工主数据，主数据每个工号唯一，明细允许多行，使用 many_to_one，并核对姓名",
  "用请假表工号匹配人员主表工号，关系是多对一，姓名不一致时隔离",
  "把多笔员工记录关联到唯一员工档案，关联键为工号并校验部门",
  "以工号连接请假来源和员工主数据，左侧可重复、右侧必须唯一，同时复核姓名",
  "执行 many_to_one 员工关联：请假工号对应主数据工号，并检查姓名和部门",
].forEach((instruction, index) => scenarios.push(planScenario("join", `join-${index + 1}`, instruction, joinArtifacts, detailTemplate)));

const calculationTemplate = template("real-calculation", [{ columnId: "result", dataType: "decimal" }]);
[
  "计算 result 为金额乘以0.1，并保留2位小数",
  "将 result 计算为小时数乘以费率，结果四舍五入到2位",
  "result 等于金额加100，保留2位小数",
  "计算 result 为金额除以2，明确舍入到2位",
  "result 取金额和500中的较小值",
].forEach((instruction, index) => scenarios.push(planScenario("calculation", `calculation-${index + 1}`, instruction, source, calculationTemplate)));

const outputTemplate = template("real-output", [{ columnId: "employee_id", dataType: "text" }]);
[
  "把处理结果绑定到目标模板的 result 工作表",
  "输出数据集必须写入 result 表，不要改变模板",
  "生成目标文件，并将最终数据明确绑定到 result sheet",
  "按模板输出到 result 工作表，保留工号字段",
  "将最终结果作为 result 工作表的数据源",
].forEach((instruction, index) => scenarios.push(planScenario("output", `output-${index + 1}`, instruction, source, outputTemplate)));

const selectedIds = new Set((process.env.MODEL_VALIDATION_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
const selectedScenarios = selectedIds.size ? scenarios.filter((scenario) => selectedIds.has(scenario.id)) : scenarios;
const rounds = Number(process.env.MODEL_VALIDATION_ROUNDS ?? 3);
const tasks = selectedScenarios.flatMap((scenario) => Array.from({ length: rounds }, (_, index) => ({ scenario, round: index + 1 })));
const results: CaseResult[] = [];
const concurrency = Number(process.env.MODEL_VALIDATION_CONCURRENCY ?? 2);
let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < tasks.length) {
    const task = tasks[cursor++], startedAt = Date.now();
    try {
      const result = await task.scenario.run();
      results.push({ id: task.scenario.id, category: task.scenario.category, round: task.round, passed: true, firstRound: result.repairRounds === 0, repairRounds: result.repairRounds, model: result.model, latencyMs: result.latencyMs ?? Date.now() - startedAt, totalTokens: result.totalTokens });
    } catch (error) {
      results.push({ id: task.scenario.id, category: task.scenario.category, round: task.round, passed: false, firstRound: false, latencyMs: Date.now() - startedAt, error: (error as Error).message.slice(0, 500) });
    }
    process.stderr.write(`真实模型验收 ${results.length}/${tasks.length}\r`);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
process.stderr.write("\n");
results.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id) || a.round - b.round);
const passed = results.filter((item) => item.passed).length, firstRound = results.filter((item) => item.passed && item.firstRound).length;
const report = {
  generatedAt: new Date().toISOString(), provider: providerId, configuredModel: process.env.SILICONFLOW_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash", protocol: "non_recursive_rule_actions_v1", structuredOutput: "json_schema", thinking: false, concurrency, rounds,
  totals: { cases: results.length, passed, failed: results.length - passed, successRate: passed / results.length, firstRoundPassed: firstRound, firstRoundSuccessRate: firstRound / results.length, threshold: 0.95, thresholdPassed: passed / results.length >= 0.95, totalTokens: results.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0), averageLatencyMs: Math.round(results.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0) / results.length) },
  byCategory: Object.fromEntries(["mapping", "filter", "join", "calculation", "output"].map((category) => { const cases = results.filter((item) => item.category === category); return [category, { cases: cases.length, passed: cases.filter((item) => item.passed).length, firstRoundPassed: cases.filter((item) => item.passed && item.firstRound).length }]; })),
  results,
};
const outputArg = process.argv.find((item) => item.startsWith("--output="))?.slice("--output=".length);
if (outputArg) await writeFile(outputArg, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (!report.totals.thresholdPassed) process.exitCode = 2;
