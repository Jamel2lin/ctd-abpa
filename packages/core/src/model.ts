import { ProcessPlanSchema, ProcessPlanV2Schema, ProcessPlanV3Schema, RuleDraftSchema, RulePatchSchema, StableIdSchema, type ExpressionV2, type PredicateV2, type ProcessPlan, type ProcessPlanV2, type ProcessPlanV3, type ProcessStepV2, type RuleDraft, type RulePatch, type RuleRequirement, type RuleSetVersion, type Scalar, type TargetTemplateVersion, type ValueOperand } from "@ctd-abpa/types";
import { z } from "zod";
import { createModelProvider, ModelResponseError, type ModelCallBudget, type ModelCallResult, type ModelProvider, type ModelProviderId } from "./providers.js";
import { redactInstruction } from "./security.js";

function assertInstructionCoverage(instruction: string, steps: Array<{ operator: string }>): void {
  const required: Array<[RegExp, string]> = [
    [/(?:只保留|仅保留|筛选|过滤|已审批|审批通过)/, "filter"],
    [/(?:汇总|聚合|求和)/, "aggregate"],
    [/(?:关联|匹配|连接|合并.*表)/, "join"],
    [/(?:去重|删除重复)/, "deduplicate"],
    [/(?:排序|按.*升序|按.*降序)/, "sort"],
  ];
  const missing = required.filter(([pattern, operator]) => pattern.test(instruction) && !steps.some((step) => step.operator === operator)).map(([, operator]) => operator);
  if (missing.length) throw new Error(`指令条件未落实为有效规则: ${missing.join("、")}`);
}

function protectDialogue(instruction: string, history: string[] = [], previousDraft?: unknown, privateTerms: string[] = []) {
  return redactInstruction([instruction, ...history.slice(-5), JSON.stringify(previousDraft ?? {})].join("\n"), privateTerms);
}

function newModelBudget(): ModelCallBudget {
  const timeout = Number(process.env.MODEL_TOTAL_TIMEOUT_MS ?? 90_000);
  return { remainingRequests: Number(process.env.MODEL_TOTAL_REQUESTS ?? 3), deadlineAt: Date.now() + timeout };
}

function repairFeedback(error: Error): string {
  if (error instanceof ModelResponseError) return JSON.stringify({ errorCode: error.code, path: error.path ?? [], failedDraft: error.draft ?? null });
  if (error instanceof z.ZodError) return JSON.stringify({ errorCode: "LOCAL_SCHEMA_INVALID", issues: error.issues.slice(0, 8).map((issue) => ({ path: issue.path, message: issue.message })) });
  return JSON.stringify({ errorCode: "LOCAL_SEMANTIC_INVALID", message: error.message.slice(0, 1000) });
}

function fatalModelError(error: Error): boolean {
  return /认证失败|未配置密钥|调用超时|模型服务错误|预留，未启用|DeepSeek 未启用|共享预算已耗尽/.test(error.message);
}

function validatePlanBindings(plan: ProcessPlanV2 | ProcessPlanV3, context: Pick<ModelPlanV2Context, "artifacts" | "template">): void {
  if (plan.targetTemplate.id !== context.template.id || plan.targetTemplate.version !== context.template.version) throw new Error("模型修改了目标模板版本");
  for (const input of plan.inputs) {
    const sheet = context.artifacts.find((artifact) => artifact.id === input.artifactId)?.sheets.find((item) => item.id === input.sheetId);
    if (!sheet) throw new Error(`模型虚构 artifact 或工作表: ${input.artifactId}/${input.sheetId}`);
    if (input.headerRows.length !== 1 || input.headerRows[0] !== sheet.headerRow) throw new Error("模型变更了表头行，需人工确认");
    for (const column of input.columns) if (sheet.columns[column.sourceIndex]?.header !== column.sourceHeader) throw new Error(`模型虚构或错位字段: ${column.sourceHeader}`);
  }
}

function suggestedColumnId(header: string, index: number, master = false): string {
  const mappings: Array<[RegExp, string]> = [
    [/(?:工号|人员.*(?:编号|代号)|职工编号)/, "employee_id"], [/(?:姓名|人员名称)/, "employee_name"], [/(?:部门|组织)/, "department"],
    [/(?:审批|流程状态)/, "approval_status"], [/(?:开始.*(?:日期|时间)|请假开始|日期)/, "start_date"], [/(?:员工类型|人员类型)/, "employee_type"],
    [/(?:金额|费用)/, "amount"], [/(?:小时|时长)/, "hours"], [/(?:费率|单价)/, "rate"], [/(?:岗位|职位)/, "position"],
  ];
  const id = mappings.find(([pattern]) => pattern.test(header))?.[1] ?? `column_${index + 1}`;
  return master ? `master_${id}` : id;
}

function artifactsForModel(artifacts: V3Context["artifacts"]): Array<Record<string, unknown>> {
  return artifacts.map((artifact, artifactIndex) => ({ ...artifact, sheets: artifact.sheets.map((sheet) => ({ ...sheet, columns: sheet.columns.map((column) => ({ ...column, suggestedColumnId: suggestedColumnId(column.header, column.index, artifactIndex > 0) })) })) }));
}

function basePlanForModel(context: V3Context): ProcessPlanV3 {
  const inputs = context.artifacts.flatMap((artifact, artifactIndex) => artifact.sheets.map((sheet, sheetIndex) => ({
    bindingId: `source_${artifactIndex + 1}_${sheetIndex + 1}`,
    artifactId: artifact.id,
    sheetId: sheet.id,
    headerRows: [sheet.headerRow],
    columns: sheet.columns.map((column) => ({ columnId: suggestedColumnId(column.header, column.index, artifactIndex > 0), sourceIndex: column.index, sourceHeader: column.header })),
  })));
  return {
    version: 3,
    planId: "suggested-v3",
    revision: 1,
    rules: context.ruleRef,
    inputs,
    steps: [],
    targetTemplate: { id: context.template.id, version: context.template.version },
    parameters: {},
    outputs: context.template.sheets.map((sheet) => ({ sheetId: sheet.sheetId, datasetId: inputs[0]?.bindingId ?? "source_1_1" })),
  };
}

const IntentScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const IntentOperandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), columnId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("parameter"), parameterId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("literal"), value: IntentScalarSchema }).strict(),
]);
const ModelRuleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("filter"), columnId: StableIdSchema, operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "between"]), values: z.array(IntentScalarSchema).min(1).max(20) }).strict(),
  z.object({ kind: z.literal("join"), rightBindingId: StableIdSchema, joinType: z.enum(["inner", "left"]), cardinality: z.enum(["one_to_one", "many_to_one"]), leftKeys: z.array(StableIdSchema).min(1), rightKeys: z.array(StableIdSchema).min(1), identityChecks: z.array(z.object({ left: StableIdSchema, right: StableIdSchema }).strict()) }).strict(),
  z.object({ kind: z.literal("calculate"), outputColumnId: StableIdSchema, dataType: z.enum(["text", "integer", "decimal", "boolean", "date", "datetime"]), operation: z.enum(["copy", "add", "subtract", "multiply", "divide", "min", "max"]), left: IntentOperandSchema, right: IntentOperandSchema.optional(), scale: z.number().int().min(0).max(12).optional() }).strict(),
]);
const ModelRuleDraftSchema = z.object({
  status: z.enum(["proposed", "clarification_required", "unsupported"]),
  actions: z.array(ModelRuleActionSchema).max(30),
  parameters: z.record(StableIdSchema, IntentScalarSchema),
  outputBindings: z.array(z.object({ sheetId: StableIdSchema, columns: z.array(z.object({ targetColumnId: StableIdSchema, sourceColumnId: StableIdSchema }).strict()).min(1) }).strict()),
  clarifications: z.array(z.string()),
}).strict();
type ModelRuleDraft = z.infer<typeof ModelRuleDraftSchema>;

function ruleDraftContract(instruction: string): Record<string, unknown> {
  const contract = z.toJSONSchema(ModelRuleDraftSchema, { unrepresentable: "any" }) as Record<string, unknown>;
  const actions = (contract.properties as Record<string, unknown>).actions as { maxItems?: number; items: { oneOf: Array<Record<string, unknown>> } };
  const allowed = new Set<string>();
  if (/(?:只保留|仅保留|筛选|过滤|排除|不包含|已审批|审批通过)/.test(instruction)) allowed.add("filter");
  if (/(?:关联|匹配|连接|合并.*表)/.test(instruction)) allowed.add("join");
  if (/(?:计算|换算|等于|乘以|除以|加上?|较小值|较大值)/.test(instruction)) allowed.add("calculate");
  if (allowed.size) actions.items.oneOf = actions.items.oneOf.filter((option) => allowed.has(((option.properties as Record<string, { const?: string }> | undefined)?.kind?.const) ?? ""));
  else actions.maxItems = 0;
  if (allowed.size === 1 && allowed.has("join")) actions.maxItems = 1;
  return contract;
}

function approvedConstants(instruction: string): Scalar[] {
  const values = new Set<Scalar>();
  for (const match of instruction.matchAll(/(?<![\d-])-?\d+(?:\.\d+)?(?![\d-])/g)) values.add(Number(match[0]));
  for (const pattern of [/(?:部门|车间)[为：:\s]*([^，,；;和且]+)/g, /(?:姓名|工号|员工|人员)(?:为|是|等于|：|:)\s*([^，,；;和且]+)/g, /(?:排除|不包含)\s*([^，,；;和且的]+)/g]) for (const match of instruction.matchAll(pattern)) values.add(match[1].trim());
  if (/已审批|审批通过/.test(instruction)) { values.add(true); values.add("已审批"); values.add("审批通过"); }
  for (const match of instruction.matchAll(/(20\d{2})年(\d{1,2})月份?/g)) {
    const year = Number(match[1]), month = Number(match[2]), prefix = `${year}-${String(month).padStart(2, "0")}`;
    values.add(`${prefix}-01`); values.add(`${prefix}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`);
    values.add(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`);
  }
  for (const match of instruction.matchAll(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/g)) values.add(match[0].replaceAll("/", "-"));
  return [...values];
}

function compileModelRuleDraft(context: V3Context, intent: ModelRuleDraft): RuleDraft {
  if (intent.status !== "proposed") return RuleDraftSchema.parse({ status: intent.status, plan: null, requirements: [], clarifications: intent.clarifications });
  const base = basePlanForModel(context), steps: ProcessStepV2[] = [];
  let current = base.inputs[0]?.bindingId;
  const joinedBindings = new Set<string>();
  if (!current) throw new Error("没有可用于生成规则的输入绑定");
  for (const [index, action] of intent.actions.entries()) {
    const stepId = `${action.kind}_${index + 1}`;
    if (action.kind === "filter") {
      const right = action.values.map((value) => ({ kind: "literal", value }) as const);
      steps.push({ stepId, input: current, operator: "filter", predicate: { kind: "compare", operator: action.operator, left: { kind: "column", columnId: action.columnId }, right: ["in", "between"].includes(action.operator) ? right : right[0] } });
    } else if (action.kind === "join") {
      if (joinedBindings.has(action.rightBindingId)) throw new Error(`同一右侧来源只能关联一次，身份核对应放入 identityChecks: ${action.rightBindingId}`);
      joinedBindings.add(action.rightBindingId);
      steps.push({ stepId, input: current, operator: "join", right: action.rightBindingId, joinType: action.joinType, cardinality: action.cardinality, leftKeys: action.leftKeys, rightKeys: action.rightKeys, identityChecks: action.identityChecks });
    } else {
      let expression: ExpressionV2 = action.left;
      if (action.operation !== "copy") {
        if (!action.right) throw new Error(`计算动作 ${action.outputColumnId} 缺少右操作数`);
        expression = ["min", "max"].includes(action.operation)
          ? { kind: "function", name: action.operation as "min" | "max", arguments: [action.left, action.right] }
          : { kind: "binary", operator: action.operation as "add" | "subtract" | "multiply" | "divide", left: action.left, right: action.right };
      }
      steps.push({ stepId, input: current, operator: "calculate", assignments: [{ outputColumnId: action.outputColumnId, dataType: action.dataType, scale: action.scale, expression }] });
    }
    current = stepId;
  }
  const outputs: ProcessPlanV3["outputs"] = [];
  for (const [index, sheet] of context.template.sheets.entries()) {
    const binding = intent.outputBindings.find((item) => item.sheetId === sheet.sheetId);
    if (!binding) throw new Error(`目标工作表缺少输出绑定: ${sheet.sheetId}`);
    const expected = new Set(sheet.columns.map((column) => column.columnId));
    if (binding.columns.length !== expected.size || binding.columns.some((column) => !expected.has(column.targetColumnId))) throw new Error(`目标工作表输出列绑定不完整: ${sheet.sheetId}`);
    const mappings = binding.columns.filter((column) => column.sourceColumnId !== column.targetColumnId).map((column) => ({ from: column.sourceColumnId, to: column.targetColumnId }));
    let outputInput = current;
    if (mappings.length) {
      const stepId = `output_rename_${index + 1}`;
      steps.push({ stepId, input: outputInput, operator: "rename", mappings }); outputInput = stepId;
    }
    const stepId = `output_select_${index + 1}`;
    steps.push({ stepId, input: outputInput, operator: "select", columns: sheet.columns.map((column) => column.columnId) });
    outputs.push({ sheetId: sheet.sheetId, datasetId: stepId });
  }
  return RuleDraftSchema.parse({ status: "proposed", plan: { ...base, steps, parameters: intent.parameters, outputs }, requirements: [], clarifications: intent.clarifications });
}

function v3Example(context: Omit<ModelPlanV2Context, "rules"> & { ruleRef: { id: string; version: number } }): ProcessPlanV3 | Record<string, unknown> {
  const artifact = context.artifacts[0], sheet = artifact?.sheets[0], outputSheet = context.template.sheets[0], outputColumn = outputSheet?.columns[0];
  const column = sheet?.columns.find((item) => item.inferredTypes.some((type) => type === outputColumn?.dataType || (outputColumn?.dataType === "decimal" && ["number", "integer"].includes(type)))) ?? sheet?.columns[0];
  if (!artifact || !sheet || !column || !outputSheet || !outputColumn) return { version: 3, planId: "suggested-v3", revision: 1, rules: context.ruleRef, inputs: [], steps: [], targetTemplate: { id: context.template.id, version: context.template.version }, parameters: {}, outputs: [] };
  return {
    version: 3, planId: "suggested-v3", revision: 1, rules: context.ruleRef,
    inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: sheet.id, headerRows: [sheet.headerRow], columns: [{ columnId: outputColumn.columnId, sourceIndex: column.index, sourceHeader: column.header }] }],
    steps: [{ stepId: "selected", input: "source", operator: "select", columns: [outputColumn.columnId] }],
    targetTemplate: { id: context.template.id, version: context.template.version }, parameters: {}, outputs: [{ sheetId: outputSheet.sheetId, datasetId: "selected" }],
  };
}

export interface ModelPlanContext { instruction: string; history?: string[]; headers: string[][]; rowCounts: number[]; inferredTypes: Array<Record<string, string[]>>; sources: Record<string, string>; profile?: unknown; privateTerms?: string[]; }
export interface SuggestedPlan { plan: ProcessPlan; call: Omit<ModelCallResult<ProcessPlan>, "value">; repairRounds: number; }

export async function suggestPlanDetailed(context: ModelPlanContext, providerId = (process.env.MODEL_PROVIDER ?? "deepseek") as ModelProviderId, modelProvider?: ModelProvider): Promise<SuggestedPlan> {
  const provider = modelProvider ?? createModelProvider(providerId);
  const sanitized = { headers: context.headers, rowCounts: context.rowCounts, inferredTypes: context.inferredTypes, profile: context.profile };
  const redacted = protectDialogue(context.instruction, context.history, undefined, context.privateTerms);
  const budget = newModelBudget(); let lastError: Error | undefined, feedback = "";
  for (let repairRounds = 0; repairRounds <= 2; repairRounds++) {
    try {
      const result = await provider.callStructured({
        system: "把用户指令转换为受限表格处理计划。只能引用给出的表头，不得虚构字段。所有数值计算由本地引擎完成。保留 @PRIVATE_数字@ 引用，不得猜测其原值。",
        instruction: repairRounds ? `${redacted.redact(context.instruction)}\n上一轮校验失败，请依据以下脱敏诊断修复：${feedback}` : redacted.redact(context.instruction),
        context: { ...sanitized, recentUserInstructions: redacted.redact(context.history?.slice(-5) ?? []) },
        schema: ProcessPlanSchema,
        schemaName: "process_plan_v1",
        jsonSchema: { type: "object", additionalProperties: false, required: ["version", "operation", "sources", "filters", "allowStaleBalance"], properties: { version: { const: 1 }, operation: { enum: ["erp_overtime_to_hr", "oa_leave_to_hr", "annual_leave_settlement"] }, sources: { type: "object", additionalProperties: { type: "string" } }, filters: { type: "array", items: { type: "object", additionalProperties: false, required: ["field", "operator", "value"], properties: { field: { type: "string" }, operator: { enum: ["eq", "in", "gte", "lte", "between"] }, value: {} } } }, allowStaleBalance: { type: "boolean" }, settlement: { type: "object" } } },
        example: { version: 1, operation: "oa_leave_to_hr", sources: {}, filters: [], allowStaleBalance: false },
        budget,
      });
      const plan = ProcessPlanSchema.parse({ ...redacted.restore(result.value), sources: context.sources, confirmedBy: undefined });
      if (/(?:审批|姓名|工号|员工|人员|只保留|仅保留|筛选|过滤)/.test(context.instruction) && !plan.filters.length) throw new Error("指令筛选条件未落实为有效规则");
      const { value: _value, ...call } = result; void _value;
      return { plan, call, repairRounds };
    } catch (error) {
      lastError = error as Error;
      feedback = repairFeedback(lastError);
      if (fatalModelError(lastError)) throw lastError;
    }
  }
  throw new Error(`模型结构修复超过两轮，请人工编辑：${lastError?.message ?? "未知错误"}`);
}

export async function suggestPlan(context: ModelPlanContext): Promise<ProcessPlan> { return (await suggestPlanDetailed(context)).plan; }

export interface ModelPlanV2Context {
  instruction: string;
  history?: string[];
  previousDraft?: ProcessPlanV2 | ProcessPlanV3;
  artifacts: Array<{ id: string; sheets: Array<{ id: string; headerRow: number; columns: Array<{ index: number; header: string; inferredTypes: string[] }> }> }>;
  rules: RuleSetVersion;
  template: TargetTemplateVersion;
  profile?: unknown;
  privateTerms?: string[];
}

export async function suggestPlanV2Detailed(context: ModelPlanV2Context, providerId: ModelProviderId = "deepseek", modelProvider?: ModelProvider): Promise<{ plan: ProcessPlanV2; call: Omit<ModelCallResult<ProcessPlanV2>, "value">; repairRounds: number }> {
  const provider = modelProvider ?? createModelProvider(providerId);
  const redacted = protectDialogue(context.instruction, context.history, context.previousDraft, context.privateTerms);
  const budget = newModelBudget(); let lastError: Error | undefined, feedback = "";
  for (let repairRounds = 0; repairRounds <= 2; repairRounds++) {
    try {
      const result = await provider.callStructured({
        system: "生成受限 ProcessPlanV2。仅选择给定 artifact、工作表、列和已发布步骤，不能虚构字段、修改规则或模板。无法判定时返回结构错误以便人工澄清；不得输出文件路径、原始数据或代码。保留 @PRIVATE_数字@ 引用。",
        instruction: repairRounds ? `${redacted.redact(context.instruction)}\n上轮校验失败，请依据以下脱敏诊断修复：${feedback}` : redacted.redact(context.instruction),
        context: { artifacts: context.artifacts, profile: context.profile, recentUserInstructions: redacted.redact(context.history?.slice(-5) ?? []), previousDraft: redacted.redact(context.previousDraft ?? null), rules: { id: context.rules.id, version: context.rules.version, steps: context.rules.steps }, template: { id: context.template.id, version: context.template.version, sheets: context.template.sheets.map((sheet) => ({ sheetId: sheet.sheetId, columns: sheet.columns.map((column) => ({ columnId: column.columnId, dataType: column.dataType })) })) } },
        schema: ProcessPlanV2Schema,
        schemaName: "process_plan_v2",
        example: { version: 2, planId: "suggested-plan", revision: 1, rules: { id: context.rules.id, version: context.rules.version }, inputs: [], steps: context.rules.steps, targetTemplate: { id: context.template.id, version: context.template.version } },
        budget,
      });
      const plan = ProcessPlanV2Schema.parse(redacted.restore(result.value));
      assertInstructionCoverage(context.instruction, plan.steps);
      if (plan.rules.id !== context.rules.id || plan.rules.version !== context.rules.version || JSON.stringify(plan.steps) !== JSON.stringify(context.rules.steps)) throw new Error("模型修改了已发布规则");
      validatePlanBindings(plan, context);
      const { value: _value, ...call } = result; void _value;
      return { plan, call, repairRounds };
    } catch (error) {
      lastError = error as Error;
      feedback = repairFeedback(lastError);
      if (fatalModelError(lastError)) throw lastError;
    }
  }
  throw new Error(`模型 V2 结构修复超过两轮，请人工编辑：${lastError?.message ?? "未知错误"}`);
}

export async function suggestPlanV3Detailed(context: Omit<ModelPlanV2Context, "rules"> & { ruleRef: { id: string; version: number } }, providerId: ModelProviderId = "deepseek", modelProvider?: ModelProvider): Promise<{ plan: ProcessPlanV3; call: Omit<ModelCallResult<ProcessPlanV3>, "value">; repairRounds: number }> {
  const provider = modelProvider ?? createModelProvider(providerId), redacted = protectDialogue(context.instruction, context.history, context.previousDraft, context.privateTerms);
  const budget = newModelBudget(); let lastError: Error | undefined, feedback = "";
  for (let repairRounds = 0; repairRounds <= 2; repairRounds++) {
    try {
      const result = await provider.callStructured({
        system: "从用户指令生成 ProcessPlanV3 规则草案。只使用给定 artifact、工作表、列、受限算子和目标模板；可以提出新的筛选、关联、聚合、计算规则。不得输出路径、原始记录或代码。保留 @PRIVATE_数字@ 引用，不得猜测原值。所有业务条件必须落实为步骤，否则返回无法规划的错误。",
        instruction: repairRounds ? `${redacted.redact(context.instruction)}\n上轮校验失败，请依据以下脱敏诊断修复：${feedback}` : redacted.redact(context.instruction),
        context: { artifacts: context.artifacts, profile: context.profile, recentUserInstructions: redacted.redact(context.history?.slice(-5) ?? []), previousDraft: redacted.redact(context.previousDraft ?? null), ruleRef: context.ruleRef, template: { id: context.template.id, version: context.template.version, sheets: context.template.sheets.map((sheet) => ({ sheetId: sheet.sheetId, columns: sheet.columns.map((column) => ({ columnId: column.columnId, dataType: column.dataType })) })) } },
        schema: ProcessPlanV3Schema,
        schemaName: "process_plan_v3",
        example: v3Example(context),
        budget,
      });
      const plan = ProcessPlanV3Schema.parse(redacted.restore(result.value));
      assertInstructionCoverage(context.instruction, plan.steps);
      if (plan.rules.id !== context.ruleRef.id || plan.rules.version !== context.ruleRef.version) throw new Error("模型修改了草案规则版本");
      validatePlanBindings(plan, context);
      const { value: _value, ...call } = result; void _value;
      return { plan, call, repairRounds };
    } catch (error) {
      lastError = error as Error;
      feedback = repairFeedback(lastError);
      if (fatalModelError(lastError)) throw lastError;
    }
  }
  throw new Error(`模型 V3 草案修复超过两轮，转人工澄清：${lastError?.message ?? "未知错误"}`);
}

type V3Context = Omit<ModelPlanV2Context, "rules"> & { ruleRef: { id: string; version: number } };
type AtomicPredicate = Extract<PredicateV2, { kind: "compare" }>;

function atomicPredicates(predicate: PredicateV2): AtomicPredicate[] {
  if (predicate.kind === "compare") return [predicate];
  if (predicate.kind === "not") return atomicPredicates(predicate.item);
  return predicate.items.flatMap(atomicPredicates);
}

function operandScalar(operand: ValueOperand, parameters: Record<string, Scalar>): Scalar | undefined {
  if (operand?.kind === "literal") return operand.value;
  if (operand?.kind === "parameter") return parameters[operand.parameterId];
  return undefined;
}

function filterEvidence(plan: ProcessPlanV3): Array<{ stepId: string; predicate: AtomicPredicate }> {
  return plan.steps.flatMap((step) => step.operator === "filter" ? atomicPredicates(step.predicate).map((predicate) => ({ stepId: step.stepId, predicate })) : []);
}

function columnOf(predicate: AtomicPredicate): string {
  return predicate.left.kind === "column" ? predicate.left.columnId : "";
}

function valuesOf(predicate: AtomicPredicate, parameters: Record<string, Scalar>): Scalar[] {
  return (Array.isArray(predicate.right) ? predicate.right : [predicate.right]).map((item) => operandScalar(item, parameters)).filter((item): item is Scalar => item !== undefined);
}

function rangeEvidence(evidence: Array<{ stepId: string; predicate: AtomicPredicate }>, parameters: Record<string, Scalar>, start: string, end: string, next?: string): { stepId: string } | undefined {
  const dates = evidence.filter(({ predicate }) => /date|time|日期|时间/i.test(columnOf(predicate)));
  const between = dates.find(({ predicate }) => predicate.operator === "between" && valuesOf(predicate, parameters).map(String).includes(start) && valuesOf(predicate, parameters).map(String).includes(end));
  if (between) return between;
  for (const lower of dates.filter(({ predicate }) => ["gte", "gt"].includes(predicate.operator) && valuesOf(predicate, parameters).map(String).includes(start))) {
    const upper = dates.find(({ stepId, predicate }) => stepId === lower.stepId && ((predicate.operator === "lte" && valuesOf(predicate, parameters).map(String).includes(end)) || (next && predicate.operator === "lt" && valuesOf(predicate, parameters).map(String).includes(next))));
    if (upper) return lower;
  }
  return undefined;
}

function localAmbiguities(instruction: string): string[] {
  const questions: string[] = [];
  if (/(?:^|[^\d])(?:[1-9]|1[0-2])月份?/.test(instruction) && !/20\d{2}年/.test(instruction)) questions.push("月份缺少年份，请明确要处理的年份。");
  if (/(?:年假.*抵扣|余额.*抵扣|优先抵扣)/.test(instruction) && /请假/.test(instruction) && !/(?:仅|只).{0,4}事假|所有假别|全部假别|事假/.test(instruction)) questions.push("请明确年假余额抵扣适用于所有假别，还是仅适用于事假。");
  return questions;
}

function requirementEvidence(instruction: string, plan: ProcessPlanV3): RuleRequirement[] {
  const evidence = filterEvidence(plan), requirements: RuleRequirement[] = [];
  const add = (sourceText: string, kind: RuleRequirement["kind"], match?: { stepId: string }, reason?: string) => requirements.push({ id: `req-${requirements.length + 1}`, sourceText, kind, status: match ? "satisfied" : "unsupported", stepId: match?.stepId, reason: match ? undefined : reason ?? "没有找到可验证的规则节点" });
  const department = /(?:部门|车间)[为：:\s]*([^，,；;和且]+?)(?=，|,|；|;|和|且|$)/.exec(instruction);
  if (department) {
    const expected = department[1].trim();
    add(department[0], "filter", evidence.find(({ predicate }) => /department|dept|部门|车间/i.test(columnOf(predicate)) && valuesOf(predicate, plan.parameters).some((value) => String(value) === expected)), `未找到部门字段等于“${expected}”的筛选节点`);
  }
  const approvalText = /已审批|审批通过/.exec(instruction)?.[0];
  if (approvalText) add(approvalText, "filter", evidence.find(({ predicate }) => /approv|审批|状态/i.test(columnOf(predicate)) && valuesOf(predicate, plan.parameters).some((value) => value === true || /已审批|通过|approved/i.test(String(value)))), "未找到审批状态筛选节点");
  const month = /(20\d{2})年(\d{1,2})月份?/.exec(instruction);
  if (month) {
    const year = Number(month[1]), monthNumber = Number(month[2]), prefix = `${year}-${String(monthNumber).padStart(2, "0")}`;
    const start = `${prefix}-01`, end = `${prefix}-${new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()}`;
    const nextYear = monthNumber === 12 ? year + 1 : year, nextMonth = monthNumber === 12 ? 1 : monthNumber + 1, next = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
    add(month[0], "filter", rangeEvidence(evidence, plan.parameters, start, end, next), `未找到覆盖 ${start} 至 ${end} 的完整时间范围筛选节点`);
  }
  const dateRange = /(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s*(?:至|到|~|—)\s*(20\d{2}[-/]\d{1,2}[-/]\d{1,2})/.exec(instruction);
  if (dateRange) add(dateRange[0], "filter", rangeEvidence(evidence, plan.parameters, dateRange[1].replaceAll("/", "-"), dateRange[2].replaceAll("/", "-")), "未找到完整时间范围筛选节点");
  const nameOrId = /(?:姓名|工号|员工|人员)(?:为|是|等于|：|:)\s*([^，,；;和且]+?)(?=，|,|；|;|和|且|$)/.exec(instruction);
  if (nameOrId) {
    const expected = nameOrId[1].trim();
    add(nameOrId[0], "filter", evidence.find(({ predicate }) => /name|employee|staff|工号|姓名|员工|人员/i.test(columnOf(predicate)) && valuesOf(predicate, plan.parameters).some((value) => String(value) === expected)), `未找到人员条件“${expected}”的筛选节点`);
  }
  const simpleSelection = !department && !nameOrId ? /(?:只|仅)保留\s*([^，,；;和且的]{1,20})(?=，|,|；|;|和|且|的|$)/.exec(instruction) : undefined;
  if (simpleSelection) {
    const expected = simpleSelection[1].trim();
    add(simpleSelection[0], "filter", evidence.find(({ predicate }) => valuesOf(predicate, plan.parameters).some((value) => String(value) === expected)), `筛选节点没有落实值“${expected}”`);
  }
  const exclusion = /(?:排除|不包含|不要)\s*([^，,；;和且的]{1,20})(?=，|,|；|;|和|且|的|$)/.exec(instruction);
  if (exclusion && !/(?:模板|格式|表头|列序)/.test(exclusion[1])) {
    const expected = exclusion[1].trim(), step = plan.steps.find((item) => item.operator === "filter" && JSON.stringify(item.predicate).includes(expected) && /"kind":"not"|"operator":"neq"/.test(JSON.stringify(item.predicate)));
    add(exclusion[0], "filter", step, `未找到排除“${expected}”的否定筛选节点`);
  }
  const operatorRequirements: Array<[RegExp, RuleRequirement["kind"], string]> = [
    [/(?:关联|匹配|连接|合并.*表)/, "join", "join"], [/(?:汇总|聚合|求和)/, "calculation", "aggregate"], [/(?:计算|换算|抵扣|余额分配)/, "calculation", "calculate|allocate_balance"], [/(?:输出|写入|生成.*表)/, "output", "output"],
  ];
  for (const [pattern, kind, operators] of operatorRequirements) {
    const sourceText = pattern.exec(instruction)?.[0]; if (!sourceText) continue;
    const step = operators === "output" ? { stepId: plan.outputs[0]?.datasetId } : plan.steps.find((item) => new RegExp(`^(?:${operators})$`).test(item.operator));
    add(sourceText, kind, step?.stepId ? { stepId: step.stepId } : undefined);
  }
  if (!requirements.length && /只保留|仅保留|筛选|过滤/.test(instruction)) add("筛选要求", "filter", plan.steps.find((step) => step.operator === "filter"));
  return requirements;
}

function validateRequirementLinks(draft: RuleDraft): void {
  if (!draft.plan) return;
  const steps = new Map(draft.plan.steps.map((step) => [step.stepId, step]));
  for (const requirement of draft.requirements) if (requirement.status === "satisfied") {
    if (!requirement.stepId) throw new Error(`条件 ${requirement.id} 标记为已落实但没有规则节点`);
    if (requirement.kind !== "output" && !steps.has(requirement.stepId)) throw new Error(`条件 ${requirement.id} 引用了不存在的规则节点: ${requirement.stepId}`);
    if (requirement.kind === "output" && !draft.plan.outputs.some((output) => output.datasetId === requirement.stepId)) throw new Error(`输出条件 ${requirement.id} 未绑定有效数据集`);
  }
}

function validateConstantProvenance(plan: ProcessPlanV3, instruction: string, history: string[], template: TargetTemplateVersion): void {
  const approvedText = [instruction, ...history].join("\n"), approved = new Set<Scalar>([null, 0, ...template.sheets.flatMap((sheet) => sheet.columns.map((column) => column.defaultValue).filter((value): value is Scalar => value !== undefined))]);
  if (/已审批|审批通过/.test(approvedText)) { approved.add(true); approved.add("已审批"); approved.add("审批通过"); }
  for (const match of approvedText.matchAll(/(20\d{2})年(\d{1,2})月份?/g)) {
    const year = Number(match[1]), month = Number(match[2]), prefix = `${year}-${String(month).padStart(2, "0")}`;
    approved.add(`${prefix}-01`); approved.add(`${prefix}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`);
    approved.add(`${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, "0")}-01`);
  }
  for (const match of approvedText.matchAll(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/g)) approved.add(match[0].replaceAll("/", "-"));
  for (const value of Object.values(plan.parameters)) {
    if (value !== null && !approved.has(value) && !approvedText.includes(String(value))) throw new Error(`参数 ${String(value)} 未来自当前指令或已确认事实`);
    approved.add(value);
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.kind === "literal" && "value" in record) {
      const literal = record.value as Scalar;
      if (!approved.has(literal) && !approvedText.includes(String(literal))) throw new Error(`常量 ${String(literal)} 缺少原始指令、已确认参数或模板配置依据`);
    }
    for (const child of Object.values(record)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  plan.steps.forEach(visit);
}

export async function suggestRuleDraftV3Detailed(context: V3Context, providerId: ModelProviderId = "deepseek", modelProvider?: ModelProvider): Promise<{ draft: RuleDraft; call?: Omit<ModelCallResult<RuleDraft>, "value">; repairRounds: number }> {
  const ambiguities = localAmbiguities(context.instruction);
  if (ambiguities.length) return { draft: { status: "clarification_required", plan: null, requirements: ambiguities.map((sourceText, index) => ({ id: `req-${index + 1}`, sourceText, kind: "parameter", status: "ambiguous", reason: sourceText })), clarifications: ambiguities }, repairRounds: 0 };
  const provider = modelProvider ?? createModelProvider(providerId), redacted = protectDialogue(context.instruction, context.history, context.previousDraft, context.privateTerms), budget = newModelBudget();
  let lastError: Error | undefined, feedback = "";
  const exampleOutput = context.template.sheets.map((sheet) => ({ sheetId: sheet.sheetId, columns: sheet.columns.map((column) => ({ targetColumnId: column.columnId, sourceColumnId: column.columnId })) }));
  const example = { status: "proposed", actions: [], parameters: {}, outputBindings: exampleOutput, clarifications: [] };
  for (let repairRounds = 0; repairRounds <= 2; repairRounds++) {
    try {
      const result = await provider.callStructured({
        system: "生成 RuleDraft 的非递归语义动作。若指令可由给定字段和动作表达，必须返回 proposed；只有缺少必要参数或存在多种业务含义时才返回 clarification_required，只有动作目录无法表达时才返回 unsupported。没有提供原始数据行是刻意设计，不构成歧义。只能生成 outputContract 允许的动作类型；literal 和 parameters 的值只能来自 approvedConstants，禁止占位数、哨兵值和示例外常量。filter 每个动作表达一个条件，多个 filter 按 AND 串联；每对来源只生成一个 join，左侧可重复且右侧唯一就是 many_to_one，姓名或部门核对必须放在该 join 的 identityChecks，不能再生成第二个 join；join 的 rightBindingId 必须来自 basePlan；calculate 只允许白名单二元运算或 min/max；outputBindings 必须逐列绑定所有模板列。输入、规则、步骤 ID、模板及最终计划由本地编译，不要复写。不得虚构字段、静默忽略条件、擅自增加筛选或生成业务结果。保留 @PRIVATE_数字@ 引用。",
        instruction: repairRounds ? `${redacted.redact(context.instruction)}\n依据以下脱敏校验诊断修复，不要猜测：${feedback}` : redacted.redact(context.instruction),
        context: { artifacts: artifactsForModel(context.artifacts), basePlan: basePlanForModel(context), approvedConstants: approvedConstants(redacted.redact(context.instruction)), actionCatalog: ["filter(eq|neq|gt|gte|lt|lte|in|between)", "join(many_to_one|one_to_one)", "calculate(copy|add|subtract|multiply|divide|min|max)", "outputBindings"], profile: context.profile, recentUserInstructions: redacted.redact(context.history?.slice(-5) ?? []), previousDraft: redacted.redact(context.previousDraft ?? null), ruleRef: context.ruleRef, template: context.template },
        schema: ModelRuleDraftSchema, schemaName: "rule_draft_v3", jsonSchema: ruleDraftContract(context.instruction), example, budget,
      });
      const intent = ModelRuleDraftSchema.parse(redacted.restore(result.value));
      const draft = compileModelRuleDraft(context, intent);
      if (draft.status === "proposed") {
        const plan = ProcessPlanV3Schema.parse(draft.plan);
        if (plan.rules.id !== context.ruleRef.id || plan.rules.version !== context.ruleRef.version) throw new Error("模型修改了草案规则版本");
        validatePlanBindings(plan, context); assertInstructionCoverage(context.instruction, plan.steps); validateConstantProvenance(plan, context.instruction, context.history ?? [], context.template);
        const localRequirements = requirementEvidence(context.instruction, plan);
        const failures = localRequirements.filter((item) => item.status !== "satisfied");
        if (failures.length) throw new Error(`条件未逐项落实：${failures.map((item) => `${item.sourceText}（${item.reason}）`).join("；")}`);
        draft.requirements = localRequirements.length ? localRequirements : draft.requirements;
      }
      validateRequirementLinks(draft);
      const { value: _value, ...call } = result; void _value;
      return { draft, call, repairRounds };
    } catch (error) {
      lastError = error as Error; feedback = repairFeedback(lastError);
      if (fatalModelError(lastError)) throw lastError;
    }
  }
  throw new Error(`模型 RuleDraft 修复超过两轮，转人工澄清：${lastError?.message ?? "未知错误"}`);
}

export async function suggestRulePatchDetailed(args: { instruction: string; current: RuleSetVersion; privateTerms?: string[]; providerId?: ModelProviderId; modelProvider?: ModelProvider }): Promise<{ status: "proposed"; patch: RulePatch; call: Omit<ModelCallResult<RulePatch>, "value">; repairRounds: number } | { status: "clarification_required"; clarifications: string[]; repairRounds: 0 }> {
  if (/临时工/.test(args.instruction) && /不要这样匹配/.test(args.instruction) && !/(?:排除|保留|关联键|匹配字段)/.test(args.instruction)) return { status: "clarification_required", clarifications: ["请明确是调整临时工的匹配字段/方式，还是从结果中排除临时工记录。"], repairRounds: 0 };
  const provider = args.modelProvider ?? createModelProvider(args.providerId ?? "deepseek"), redacted = redactInstruction(args.instruction, args.privateTerms), budget = newModelBudget();
  let lastError: Error | undefined, feedback = "";
  for (let repairRounds = 0; repairRounds <= 2; repairRounds++) {
    try {
      const result = await provider.callStructured({
        system: "只生成针对当前规则明确节点的增量修改 RulePatch，不得重生成整份规则。删除步骤必须是用户明确要求；无法定位目标节点时不要猜测。保留 @PRIVATE_数字@ 引用。",
        instruction: repairRounds ? `${redacted.text}\n依据以下脱敏诊断修复：${feedback}` : redacted.text,
        context: { rule: { id: args.current.id, version: args.current.version, steps: args.current.steps } },
        schema: RulePatchSchema,
        schemaName: "rule_patch",
        example: { baseRevision: args.current.version, rationale: "按明确指令增加审批筛选", operations: [{ operation: "add_step", afterStepId: args.current.steps.at(-1)?.stepId, step: { stepId: "approved", input: args.current.steps.at(-1)?.stepId ?? "source", operator: "filter", predicate: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "approved" }, right: { kind: "literal", value: true } } } }] },
        budget,
      });
      const patch = RulePatchSchema.parse(redacted.restore(result.value));
      if (patch.baseRevision !== args.current.version) throw new Error("模型修改了增量操作的基础修订号");
      const { value: _value, ...call } = result; void _value; return { status: "proposed", patch, call, repairRounds };
    } catch (error) { lastError = error as Error; feedback = repairFeedback(lastError); if (fatalModelError(lastError)) throw lastError; }
  }
  throw new Error(`模型增量修改修复超过两轮，转人工澄清：${lastError?.message ?? "未知错误"}`);
}

export const MappingAdviceSchema = z.object({ mappings: z.array(z.object({ standardField: z.string().min(1), sourceHeader: z.string().min(1), confidence: z.number().min(0).max(1), rationale: z.string().min(1) }).strict()), clarificationQuestions: z.array(z.string()).default([]) }).strict();
export type MappingAdvice = z.infer<typeof MappingAdviceSchema>;

export async function suggestMappings(args: { instruction: string; headers: string[]; inferredTypes: Record<string, string[]>; privateTerms?: string[]; provider?: ModelProviderId; modelProvider?: ModelProvider }): Promise<{ advice: MappingAdvice; call: Omit<ModelCallResult<MappingAdvice>, "value"> }> {
  const provider = args.modelProvider ?? createModelProvider(args.provider ?? (process.env.MODEL_PROVIDER ?? "deepseek") as ModelProviderId);
  const redacted = redactInstruction(args.instruction, args.privateTerms);
  const result = await provider.callStructured({ system: "根据表头和类型提出字段映射候选及依据。不确定或冲突时必须提出澄清问题。不得虚构源字段。employeeId 是稳定且唯一的员工编号，只能映射到工号、人员编号、人员代号或职工编号，不能映射到姓名、部门等属性。保留 @PRIVATE_数字@ 引用。", instruction: redacted.text, context: { headers: args.headers, inferredTypes: args.inferredTypes }, schema: MappingAdviceSchema, schemaName: "mapping_advice", jsonSchema: { type: "object", additionalProperties: false, required: ["mappings", "clarificationQuestions"], properties: { mappings: { type: "array", items: { type: "object", additionalProperties: false, required: ["standardField", "sourceHeader", "confidence", "rationale"], properties: { standardField: { type: "string" }, sourceHeader: { type: "string" }, confidence: { type: "number" }, rationale: { type: "string" } } } }, clarificationQuestions: { type: "array", items: { type: "string" } } } }, example: { mappings: [{ standardField: "employeeId", sourceHeader: "人员编号", confidence: 0.95, rationale: "表头语义一致" }], clarificationQuestions: [] } });
  const invalid = result.value.mappings.filter((mapping) => !args.headers.includes(mapping.sourceHeader));
  if (invalid.length) throw new Error(`模型虚构字段: ${invalid.map((mapping) => mapping.sourceHeader).join(", ")}`);
  const { value, ...call } = result; return { advice: redacted.restore(value), call };
}
