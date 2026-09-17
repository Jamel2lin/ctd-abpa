import { describe, expect, it } from "vitest";
import { redactInstruction, suggestMappings, suggestPlanDetailed, suggestPlanV2Detailed, suggestPlanV3Detailed, suggestRuleDraftV3Detailed, suggestRulePatchDetailed, type ModelProvider } from "@ctd-abpa/core";
import { RuleSetVersionSchema } from "@ctd-abpa/types";

const context = { instruction: "处理请假", headers: [["工号"]], rowCounts: [1], inferredTypes: [{ 工号: ["string"] }], sources: { leave: "private/path.xlsx" } };

describe("模型业务边界", () => {
  it("人名和工号在发给模型前替换为可恢复引用", () => {
    const redacted = redactInstruction("只保留张三、李四和工号为001的记录", ["张三", "李四", "001"]);
    expect(redacted.text).not.toMatch(/张三|李四|001/);
    expect(redacted.references).toBe(3);
    expect(redacted.restore({ values: ["@PRIVATE_1@", "@PRIVATE_2@", "@PRIVATE_3@"] }).values.sort()).toEqual(["001", "张三", "李四"].sort());
  });
  it("结构修复最多两轮，随后转人工编辑", async () => {
    let calls = 0;
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured() { calls++; return { status: "success", provider: "deepseek", model: "test", value: { version: 1, operation: "invented" }, usage: {}, attempts: 1 } as never; } };
    await expect(suggestPlanDetailed(context, "deepseek", provider)).rejects.toThrow(/超过两轮/); expect(calls).toBe(3);
  });

  it("拒绝模型虚构的源字段", async () => {
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured() { return { status: "success", provider: "deepseek", model: "test", value: { mappings: [{ standardField: "employeeId", sourceHeader: "不存在字段", confidence: 1, rationale: "猜测" }], clarificationQuestions: [] }, usage: {}, attempts: 1 } as never; } };
    await expect(suggestMappings({ instruction: "映射", headers: ["工号"], inferredTypes: {}, modelProvider: provider })).rejects.toThrow(/虚构字段/);
  });

  it("V2 建议仅用脱敏结构，错位字段修复后绑定固定规则版本", async () => {
    const v2 = { version: 2, planId: "suggested", revision: 1, rules: { id: "rule", version: 1 }, inputs: [{ bindingId: "source", artifactId: "artifact-1", sheetId: "sheet-1", headerRows: [1], columns: [{ columnId: "id", sourceIndex: 0, sourceHeader: "工号" }] }], steps: [], targetTemplate: { id: "template", version: 1 } };
    let calls = 0, sent = "";
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured(request) { calls++; sent = JSON.stringify(request.context); return { status: "success", provider: "deepseek", model: "test", value: calls === 1 ? { ...v2, inputs: [{ ...v2.inputs[0], columns: [{ columnId: "id", sourceIndex: 0, sourceHeader: "虚构工号" }] }] } : v2, usage: {}, attempts: 1 } as never; } };
    const suggestion = await suggestPlanV2Detailed({ instruction: "按工号映射", artifacts: [{ id: "artifact-1", sheets: [{ id: "sheet-1", headerRow: 1, columns: [{ index: 0, header: "工号", inferredTypes: ["string"] }] }] }], rules: { id: "rule", version: 1, name: "规则", status: "published", aliases: {}, steps: [] }, template: { id: "template", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" }] }] } }, "deepseek", provider);
    expect(suggestion.repairRounds).toBe(1); expect(calls).toBe(2); expect(suggestion.plan.inputs[0].columns[0].sourceHeader).toBe("工号"); expect(sent).not.toContain("private/path.xlsx");
  });

  it("V3 新规则草案必须覆盖筛选条件并保留私有引用", async () => {
    const base = { version: 3, planId: "draft", revision: 1, rules: { id: "draft.task", version: 1 }, inputs: [{ bindingId: "source", artifactId: "artifact-1", sheetId: "sheet-1", headerRows: [1], columns: [{ columnId: "name", sourceIndex: 0, sourceHeader: "姓名" }] }], steps: [], targetTemplate: { id: "template", version: 1 }, outputs: [{ sheetId: "out", datasetId: "source" }], parameters: {} };
    let calls = 0, sent = "";
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured(request) { calls++; sent = JSON.stringify({ instruction: request.instruction, context: request.context }); return { status: "success", provider: "deepseek", model: "test", value: calls === 1 ? base : { ...base, steps: [{ stepId: "chosen", input: "source", operator: "filter", predicate: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "name" }, right: { kind: "literal", value: "@PRIVATE_1@" } } }], outputs: [{ sheetId: "out", datasetId: "chosen" }] }, usage: {}, attempts: 1 } as never; } };
    const result = await suggestPlanV3Detailed({ instruction: "只保留张三", history: ["先看张三的记录"], previousDraft: { ...base, parameters: { person: "张三" } }, artifacts: [{ id: "artifact-1", sheets: [{ id: "sheet-1", headerRow: 1, columns: [{ index: 0, header: "姓名", inferredTypes: ["string"] }] }] }], template: { id: "template", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "name", header: "姓名", dataType: "text" }] }] }, ruleRef: { id: "draft.task", version: 1 }, privateTerms: ["张三"] }, "deepseek", provider);
    expect(calls).toBe(2);
    expect(sent).not.toContain("张三");
    expect(sent).toContain("recentUserInstructions"); expect(sent).toContain("previousDraft");
    expect(result.plan.steps[0].operator).toBe("filter");
    if (result.plan.steps[0].operator === "filter" && result.plan.steps[0].predicate.kind === "compare") expect(result.plan.steps[0].predicate.right).toEqual({ kind: "literal", value: "张三" });
  });

  it("月份缺少年份时不调用模型并返回明确澄清", async () => {
    let calls = 0;
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured() { calls++; throw new Error("不应调用"); } };
    const result = await suggestRuleDraftV3Detailed({ instruction: "筛选4月份已审批的请假", artifacts: [], template: { id: "template", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" }] }] }, ruleRef: { id: "draft.task", version: 1 } }, "deepseek", provider);
    expect(calls).toBe(0); expect(result.draft.status).toBe("clarification_required"); expect(result.draft.clarifications[0]).toMatch(/年份/);
  });

  it("RuleDraft 逐项绑定条件，并把具体校验路径反馈给修复轮次", async () => {
    let calls = 0, repairInstruction = "";
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured(request) { calls++; repairInstruction = request.instruction; return { status: "success", provider: "deepseek", model: "actual-model", value: calls === 1 ? { status: "proposed", clarifications: [] } : { status: "proposed", actions: [], parameters: {}, outputBindings: [{ sheetId: "out", columns: [{ targetColumnId: "id", sourceColumnId: "employee_id" }] }], clarifications: [] }, usage: {}, attempts: 1, latencyMs: 2 } as never; } };
    const result = await suggestRuleDraftV3Detailed({ instruction: "输出原表", artifacts: [{ id: "artifact-1", sheets: [{ id: "sheet-1", headerRow: 1, columns: [{ index: 0, header: "工号", inferredTypes: ["string"] }] }] }], template: { id: "template", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" }] }] }, ruleRef: { id: "draft.task", version: 1 } }, "deepseek", provider);
    expect(calls).toBe(2); expect(repairInstruction).toContain("LOCAL_SCHEMA_INVALID"); expect(repairInstruction).toContain("actions");
    expect(result.draft.requirements).toEqual([{ id: "req-1", sourceText: "输出", kind: "output", status: "satisfied", stepId: "output_select_1" }]);
    expect(result.call?.model).toBe("actual-model");
  });

  it("复合筛选必须逐项落实部门、月份和审批条件", async () => {
    const department = { kind: "filter", columnId: "department", operator: "eq", values: ["研发"] };
    const complete = [department, { kind: "filter", columnId: "start_date", operator: "between", values: ["2026-04-01", "2026-04-30"] }, { kind: "filter", columnId: "approval_status", operator: "eq", values: [true] }];
    let calls = 0;
    const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured() { calls++; return { status: "success", provider: "deepseek", model: "test", value: { status: "proposed", actions: calls === 1 ? [department] : complete, parameters: {}, outputBindings: [{ sheetId: "out", columns: [{ targetColumnId: "department", sourceColumnId: "department" }] }], clarifications: [] }, usage: {}, attempts: 1 } as never; } };
    const result = await suggestRuleDraftV3Detailed({ instruction: "只保留部门为研发，2026年4月份，已审批的记录", artifacts: [{ id: "artifact-1", sheets: [{ id: "sheet-1", headerRow: 1, columns: [{ index: 0, header: "部门", inferredTypes: ["string"] }, { index: 1, header: "日期", inferredTypes: ["date"] }, { index: 2, header: "审批", inferredTypes: ["boolean"] }] }] }], template: { id: "template", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "department", header: "部门", dataType: "text" }] }] }, ruleRef: { id: "draft.task", version: 1 } }, "deepseek", provider);
    expect(calls).toBe(2); expect(result.draft.requirements.map((item) => item.sourceText)).toEqual(expect.arrayContaining(["部门为研发", "2026年4月份", "已审批"]));
  });

  it("含糊的自然语言规则修改不会被推断成删除数据", async () => {
    let calls = 0; const provider: ModelProvider = { id: "deepseek", capability: "enabled", async callStructured() { calls++; throw new Error("不应调用"); } };
    const result = await suggestRulePatchDetailed({ instruction: "临时工不要这样匹配", current: RuleSetVersionSchema.parse({ id: "rule", version: 1, name: "规则", status: "published", aliases: {}, steps: [], scope: { kind: "source", sourceIdentity: "oa:leave" } }), modelProvider: provider });
    expect(calls).toBe(0); expect(result.status).toBe("clarification_required");
  });
});
