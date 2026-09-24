import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "draft", "analyzed", "awaiting_clarification", "awaiting_confirmation", "ready", "running",
  "completed_with_exceptions", "completed", "failed", "cancelled"
]);

export type TaskStatus = "draft" | "analyzed" | "awaiting_clarification" | "awaiting_confirmation" | "ready" | "running" |
  "completed_with_exceptions" | "completed" | "failed" | "cancelled";

export const ArtifactKindSchema = z.enum(["overtime", "leave", "annual_balance", "template", "unknown"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export interface SourceArtifact {
  id: string;
  fileName: string;
  path: string;
  sha256: string;
  kind: ArtifactKind;
  sheets: SheetAnalysis[];
}

export interface SheetAnalysis {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  headerRow: number;
  headers: string[];
  duplicateHeaders: string[];
  emptyRows: number[];
  inferredTypes: Record<string, string[]>;
  fingerprint: string;
  columns: Array<{ id: string; index: number; header: string; inferredTypes: string[] }>;
}

export interface NormalizedRow<T extends Record<string, unknown> = Record<string, unknown>> {
  sourceFile: string;
  sourceSheet: string;
  sourceRow: number;
  raw: Record<string, unknown>;
  value: T;
}

export const FilterSpecSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "in", "gte", "lte", "between"]),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});
export type FilterSpec = z.infer<typeof FilterSpecSchema>;

export const JoinSpecSchema = z.object({
  leftField: z.string(), rightField: z.string(),
  identityChecks: z.array(z.string()).default([]),
});
export type JoinSpec = z.infer<typeof JoinSpecSchema>;

export const SettlementRuleSchema = z.object({
  enabledForLeaveTypes: z.array(z.string()).default(["事假"]),
  annualLeaveType: z.string().default("年假"),
  fallbackLeaveType: z.string().default("事假"),
  minutesPerDay: z.number().int().positive().default(480),
});
export type SettlementRule = z.infer<typeof SettlementRuleSchema>;

export const ProcessPlanSchema = z.object({
  version: z.literal(1),
  operation: z.enum(["erp_overtime_to_hr", "oa_leave_to_hr", "annual_leave_settlement"]),
  sources: z.record(z.string(), z.string()),
  filters: z.array(FilterSpecSchema).default([]),
  mappingProfile: z.string().optional(),
  settlement: SettlementRuleSchema.optional(),
  allowStaleBalance: z.boolean().default(false),
  confirmedBy: z.string().optional(),
});
export type ProcessPlan = z.infer<typeof ProcessPlanSchema>;

// V2 plans are deliberately declarative. They may reference task-owned artifacts,
// versioned rules and templates, but never filesystem paths or executable code.
export const StableIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const DataTypeSchema = z.enum(["text", "integer", "decimal", "boolean", "date", "datetime"]);
export type DataType = z.infer<typeof DataTypeSchema>;

export const VersionRefSchema = z.object({ id: StableIdSchema, version: z.number().int().positive() }).strict();
export type VersionRef = z.infer<typeof VersionRefSchema>;

export const ColumnBindingSchema = z.object({
  columnId: StableIdSchema,
  sourceIndex: z.number().int().nonnegative(),
  sourceHeader: z.string(),
}).strict();

export const InputBindingV2Schema = z.object({
  bindingId: StableIdSchema,
  artifactId: StableIdSchema,
  sheetId: StableIdSchema,
  headerRows: z.array(z.number().int().positive()).min(1),
  columns: z.array(ColumnBindingSchema).min(1),
}).strict();
export type InputBindingV2 = z.infer<typeof InputBindingV2Schema>;

const ScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof ScalarSchema>;
export type ValueOperand = { kind: "column"; columnId: string } | { kind: "parameter"; parameterId: string } | { kind: "literal"; value: Scalar };
export const ValueOperandSchema: z.ZodType<ValueOperand> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), columnId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("parameter"), parameterId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("literal"), value: ScalarSchema }).strict(),
]);

export type PredicateV2 =
  | { kind: "compare"; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "between"; left: ValueOperand; right: ValueOperand | ValueOperand[] }
  | { kind: "all" | "any"; items: PredicateV2[] }
  | { kind: "not"; item: PredicateV2 };
export const PredicateV2Schema: z.ZodType<PredicateV2> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("compare"),
    operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "between"]),
    left: ValueOperandSchema,
    right: z.union([ValueOperandSchema, z.array(ValueOperandSchema).min(1)]),
  }).strict(),
  z.object({ kind: z.literal("all"), items: z.array(PredicateV2Schema).min(1) }).strict(),
  z.object({ kind: z.literal("any"), items: z.array(PredicateV2Schema).min(1) }).strict(),
  z.object({ kind: z.literal("not"), item: PredicateV2Schema }).strict(),
]));

export type ExpressionV2 =
  | ValueOperand
  | { kind: "binary"; operator: "add" | "subtract" | "multiply" | "divide"; left: ExpressionV2; right: ExpressionV2 }
  | { kind: "function"; name: "min" | "max" | "round"; arguments: ExpressionV2[] }
  | { kind: "condition"; when: PredicateV2; then: ExpressionV2; otherwise: ExpressionV2 };
export const ExpressionV2Schema: z.ZodType<ExpressionV2> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("column"), columnId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("parameter"), parameterId: StableIdSchema }).strict(),
  z.object({ kind: z.literal("literal"), value: ScalarSchema }).strict(),
  z.object({ kind: z.literal("binary"), operator: z.enum(["add", "subtract", "multiply", "divide"]), left: ExpressionV2Schema, right: ExpressionV2Schema }).strict(),
  z.object({ kind: z.literal("function"), name: z.enum(["min", "max", "round"]), arguments: z.array(ExpressionV2Schema).min(1) }).strict(),
  z.object({ kind: z.literal("condition"), when: PredicateV2Schema, then: ExpressionV2Schema, otherwise: ExpressionV2Schema }).strict(),
]));

const StepBase = { stepId: StableIdSchema, input: StableIdSchema };
export const ProcessStepV2Schema = z.discriminatedUnion("operator", [
  z.object({ ...StepBase, operator: z.literal("select"), columns: z.array(StableIdSchema).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("rename"), mappings: z.array(z.object({ from: StableIdSchema, to: StableIdSchema }).strict()).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("convert"), conversions: z.array(z.object({ columnId: StableIdSchema, to: DataTypeSchema, onError: z.enum(["isolate", "null"]), format: z.string().optional() }).strict()).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("fill_null"), values: z.array(z.object({ columnId: StableIdSchema, value: ScalarSchema }).strict()).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("filter"), predicate: PredicateV2Schema }).strict(),
  z.object({ ...StepBase, operator: z.literal("join"), right: StableIdSchema, joinType: z.enum(["inner", "left"]), cardinality: z.enum(["one_to_one", "many_to_one"]), leftKeys: z.array(StableIdSchema).min(1), rightKeys: z.array(StableIdSchema).min(1), identityChecks: z.array(z.object({ left: StableIdSchema, right: StableIdSchema }).strict()).default([]) }).strict(),
  z.object({ ...StepBase, operator: z.literal("aggregate"), groupBy: z.array(StableIdSchema), metrics: z.array(z.object({ outputColumnId: StableIdSchema, function: z.enum(["sum", "count", "min", "max"]), columnId: StableIdSchema.optional() }).strict()).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("sort"), keys: z.array(z.object({ columnId: StableIdSchema, direction: z.enum(["asc", "desc"]), nulls: z.enum(["first", "last"]).default("last") }).strict()).min(1) }).strict(),
  z.object({ ...StepBase, operator: z.literal("deduplicate"), keys: z.array(StableIdSchema).min(1), keep: z.enum(["first", "last", "isolate_all"]) }).strict(),
  z.object({ ...StepBase, operator: z.literal("calculate"), assignments: z.array(z.object({ outputColumnId: StableIdSchema, dataType: DataTypeSchema, scale: z.number().int().min(0).max(12).optional(), expression: ExpressionV2Schema }).strict()).min(1) }).strict(),
  z.object({
    ...StepBase,
    operator: z.literal("allocate_balance"),
    groupBy: z.array(StableIdSchema).min(1),
    balanceColumn: StableIdSchema,
    demandColumn: StableIdSchema,
    orderBy: z.array(z.object({ columnId: StableIdSchema, direction: z.enum(["asc", "desc"]), nulls: z.enum(["first", "last"]).default("last") }).strict()).min(1),
    allocatedColumn: StableIdSchema,
    fallbackColumn: StableIdSchema,
    remainingColumn: StableIdSchema,
  }).strict(),
  z.object({
    ...StepBase,
    operator: z.literal("split_rows"),
    branches: z.array(z.object({
      branchId: StableIdSchema,
      when: PredicateV2Schema,
      assignments: z.array(z.object({ outputColumnId: StableIdSchema, dataType: DataTypeSchema, scale: z.number().int().min(0).max(12).optional(), expression: ExpressionV2Schema }).strict()).min(1),
    }).strict()).min(1),
  }).strict(),
]);
export type ProcessStepV2 = z.infer<typeof ProcessStepV2Schema>;

export const ProcessPlanV2Schema = z.object({
  version: z.literal(2),
  planId: StableIdSchema,
  revision: z.number().int().positive(),
  rules: VersionRefSchema,
  inputs: z.array(InputBindingV2Schema).min(1),
  steps: z.array(ProcessStepV2Schema),
  targetTemplate: VersionRefSchema,
}).strict().superRefine((plan, context) => {
  const ids = [...plan.inputs.map((input) => input.bindingId), ...plan.steps.map((step) => step.stepId)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "输入绑定与步骤 ID 必须唯一", path: ["steps"] });
  const available = new Set(plan.inputs.map((input) => input.bindingId));
  plan.steps.forEach((step, index) => {
    if (!available.has(step.input)) context.addIssue({ code: "custom", message: `步骤引用了尚不存在的输入: ${step.input}`, path: ["steps", index, "input"] });
    if (step.operator === "join" && !available.has(step.right)) context.addIssue({ code: "custom", message: `关联引用了尚不存在的右输入: ${step.right}`, path: ["steps", index, "right"] });
    if (step.operator === "join" && step.leftKeys.length !== step.rightKeys.length) context.addIssue({ code: "custom", message: "关联左右键数量必须一致", path: ["steps", index] });
    available.add(step.stepId);
  });
});
export type ProcessPlanV2 = z.infer<typeof ProcessPlanV2Schema>;
export const ProcessPlanV3Schema = z.object({
  ...ProcessPlanV2Schema.shape,
  version: z.literal(3),
  parameters: z.record(StableIdSchema, ScalarSchema).default({}),
  outputs: z.array(z.object({ sheetId: StableIdSchema, datasetId: StableIdSchema }).strict()).min(1),
}).strict().superRefine((plan, context) => {
  const ids = [...plan.inputs.map((input) => input.bindingId), ...plan.steps.map((step) => step.stepId)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "输入绑定与步骤 ID 必须唯一", path: ["steps"] });
  const available = new Set(plan.inputs.map((input) => input.bindingId));
  plan.steps.forEach((step, index) => {
    if (!available.has(step.input)) context.addIssue({ code: "custom", message: `步骤引用了尚不存在的输入: ${step.input}`, path: ["steps", index, "input"] });
    if (step.operator === "join" && !available.has(step.right)) context.addIssue({ code: "custom", message: `关联引用了尚不存在的右输入: ${step.right}`, path: ["steps", index, "right"] });
    if (step.operator === "join" && step.leftKeys.length !== step.rightKeys.length) context.addIssue({ code: "custom", message: "关联左右键数量必须一致", path: ["steps", index] });
    available.add(step.stepId);
  });
  for (const output of plan.outputs) if (!available.has(output.datasetId)) context.addIssue({ code: "custom", message: `输出引用了不存在的数据集: ${output.datasetId}`, path: ["outputs"] });
  if (new Set(plan.outputs.map((output) => output.sheetId)).size !== plan.outputs.length) context.addIssue({ code: "custom", message: "输出工作表 ID 必须唯一", path: ["outputs"] });
});
export type ProcessPlanV3 = z.infer<typeof ProcessPlanV3Schema>;
export const AnyProcessPlanSchema = z.union([ProcessPlanSchema, ProcessPlanV2Schema, ProcessPlanV3Schema]);
export type AnyProcessPlan = z.infer<typeof AnyProcessPlanSchema>;

export const TemplateColumnSchema = z.object({
  columnId: StableIdSchema,
  header: z.string().min(1),
  dataType: DataTypeSchema,
  required: z.boolean().default(false),
  numberFormat: z.string().optional(),
  defaultValue: ScalarSchema.optional(),
  maxLength: z.number().int().positive().optional(),
}).strict();
export const TargetTemplateVersionSchema = z.object({
  id: StableIdSchema,
  version: z.number().int().positive(),
  format: z.enum(["xls", "xlsx", "csv"]),
  sheets: z.array(z.object({
    sheetId: StableIdSchema,
    name: z.string().min(1).max(31),
    headerRow: z.number().int().positive(),
    columns: z.array(TemplateColumnSchema).min(1),
    maxDataRows: z.number().int().positive().optional(),
  }).strict()).min(1),
}).strict();
export type TargetTemplateVersion = z.infer<typeof TargetTemplateVersionSchema>;

export const RuleStatusSchema = z.enum(["draft", "validated", "confirmed", "published", "superseded"]);
export const RuleSetVersionSchema = z.object({
  id: StableIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(1),
  status: RuleStatusSchema,
  aliases: z.record(StableIdSchema, z.array(z.string().min(1))).default({}),
  steps: z.array(ProcessStepV2Schema),
  parentRevision: z.number().int().positive().optional(),
  confirmedBy: z.string().min(1).optional(),
  confirmedAt: z.string().datetime().optional(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("one_time") }).strict(),
    z.object({ kind: z.literal("source"), sourceIdentity: StableIdSchema }).strict(),
  ]).default({ kind: "one_time" }),
  validatorVersion: z.string().min(1).default("v1"),
  provenance: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual"), editedBy: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("model"), provider: z.string().min(1), model: z.string().min(1), promptHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]).optional(),
  effectiveFrom: z.string().datetime().optional(),
}).strict();
export type RuleSetVersion = z.infer<typeof RuleSetVersionSchema>;

export const RuleRequirementSchema = z.object({
  id: StableIdSchema,
  sourceText: z.string().min(1),
  kind: z.enum(["mapping", "filter", "join", "calculation", "output", "parameter"]),
  status: z.enum(["satisfied", "ambiguous", "unsupported"]),
  stepId: StableIdSchema.optional(),
  reason: z.string().min(1).optional(),
}).strict();
export type RuleRequirement = z.infer<typeof RuleRequirementSchema>;
export const RuleDraftSchema = z.object({
  status: z.enum(["proposed", "clarification_required", "unsupported"]),
  plan: ProcessPlanV3Schema.nullable(),
  requirements: z.array(RuleRequirementSchema),
  clarifications: z.array(z.string()),
}).strict().superRefine((draft, context) => {
  if (draft.status === "proposed" && !draft.plan) context.addIssue({ code: "custom", message: "可提议结果必须包含规则草案", path: ["plan"] });
  if (draft.status === "clarification_required" && !draft.clarifications.length) context.addIssue({ code: "custom", message: "待澄清结果必须包含澄清项", path: ["clarifications"] });
});
export type RuleDraft = z.infer<typeof RuleDraftSchema>;

export const RulePatchOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add_step"), afterStepId: StableIdSchema.optional(), step: ProcessStepV2Schema }).strict(),
  z.object({ operation: z.literal("replace_step"), stepId: StableIdSchema, step: ProcessStepV2Schema }).strict(),
  z.object({ operation: z.literal("remove_step"), stepId: StableIdSchema }).strict(),
]);
export const RulePatchSchema = z.object({
  baseRevision: z.number().int().positive(),
  rationale: z.string().min(1),
  operations: z.array(RulePatchOperationSchema).min(1),
}).strict();
export type RulePatch = z.infer<typeof RulePatchSchema>;

export const SourceIdentitySchema = z.object({
  id: StableIdSchema,
  system: z.string().min(1),
  reportType: z.string().min(1),
}).strict();
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;

export interface MappingProfile {
  id: string;
  version: number;
  name: string;
  sourceKind: ArtifactKind;
  sheet?: string;
  headerFingerprint?: string;
  fieldMappings: Record<string, string>;
  join?: JoinSpec;
  filters?: FilterSpec[];
  businessRules?: Record<string, unknown>;
  targetTemplate?: { sheet: string; headers: string[] };
}

export type ExceptionBusinessLevel = "L1" | "L2" | "L3" | "L4";
export type ExceptionDisposition = "auto_standardize" | "rule_based" | "alert_and_isolate" | "analyze_and_propose";

export interface ExceptionRecord {
  id: string;
  code: string;
  severity: "warning" | "error";
  businessLevel: ExceptionBusinessLevel;
  disposition: ExceptionDisposition;
  requiresHumanReview: boolean;
  automationAllowed: boolean;
  sourceOfTruth: string;
  message: string;
  sourceFile: string;
  sourceSheet: string;
  sourceRow?: number;
  sourceColumn?: number;
  columnId?: string;
  originalValue?: unknown;
  ruleId?: string;
  reason?: string;
  suggestion?: string;
  lineage?: Array<{ artifactId?: string; sourceFile: string; sourceSheet: string; sourceRow?: number; sourceColumn?: number; columnId?: string }>;
  employeeId?: string;
  raw?: Record<string, unknown>;
  resolution?: string;
}

export interface ArtifactManifest {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
  inputs: Array<{ fileName: string; sha256: string }>;
  outputs: Array<{ fileName: string; sha256: string; bytes: number }>;
  profileVersions: Record<string, number>;
  plan: ProcessPlan;
  reconciliation: Record<string, number>;
  stages?: StageReconciliation[];
  calculationSummary: Record<string, number>;
  exceptions: { total: number; warnings: number; errors: number; resolved: number };
  confirmations: Array<{ type: string; confirmedBy: string; confirmedAt: string; details?: Record<string, unknown> }>;
}

export interface StageReconciliation {
  stepId: string;
  operator: ProcessStepV2["operator"];
  inputRows: number;
  outputRows: number;
  isolatedRows: number;
  metrics: Record<string, number>;
}

export interface TaskRecord {
  id: string;
  revision?: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  files: SourceArtifact[];
  plan?: ProcessPlan;
  generic?: { plan: ProcessPlanV2 | ProcessPlanV3; rules: RuleSetVersion; template: TargetTemplateVersion; result?: { outputFile: string; outputFiles?: Array<{ fileName: string; sha256: string; outputRows: number }>; outputRows: number; stages?: StageReconciliation[]; reconciliation: { inputRows: number; filteredRows: number; isolatedRows: number; outputRows: number }; exceptions: number; sha256: string } };
  manifest?: ArtifactManifest;
  error?: string;
  workflowStage?: "analyze" | "retrieve_rules" | "plan" | "clarify" | "preview" | "confirm" | "execute" | "explain" | "save_rules";
  planRevision?: number;
  previewHash?: string;
  mappingSnapshot?: Record<string, Record<string, string[]>>;
  cancelRequested?: boolean;
  confirmation?: { planRevision: number; bindingHash: string; confirmedBy: string; confirmedAt: string };
  conversation?: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string; modelCall?: { provider: string; model: string; status: string; attempts?: number; usage?: ModelUsageRecord; latencyMs?: number; finishReason?: string; repairRounds?: number; requestSummaryHash?: string; stages?: Record<string, "passed" | "failed" | "not_run"> } }>;
  clarificationQuestions?: string[];
  mappingSuggestions?: Array<{ standardField: string; sourceHeader: string; confidence: number; rationale: string }>;
  sourceIdentities?: Record<string, SourceIdentity>;
  ruleDraft?: RuleDraft;
  patches?: Array<{ id: string; exceptionId: string; action: "correct" | "exclude"; artifactId: string; sheetId: string; sourceRow: number; columnId?: string; inputHash: string; value?: Scalar; createdAt: string; createdBy: string }>;
  archivedPatches?: NonNullable<TaskRecord["patches"]>;
  runs?: Array<{ version: number; status: TaskStatus; outputDir: string; startedAt: string; completedAt?: string; planRevision: number; patchIds: string[]; bindingHash?: string; idempotencyKey?: string; artifacts?: string[]; snapshot?: { plan: AnyProcessPlan; inputs: Array<{ artifactId: string; sha256: string }>; rules?: RuleSetVersion; template?: TargetTemplateVersion; patches: NonNullable<TaskRecord["patches"]>; mappingSnapshot?: Record<string, Record<string, string[]>> } }>;
  currentOutputDir?: string;
  staleBalanceCheck?: { isStale: boolean; balanceAsOf?: string; latestLeaveDate?: string; reason?: string };
  progress?: { phase: "idle" | "queued" | "analyzing" | "planning" | "previewing" | "executing" | "writing" | "completed" | "failed" | "cancelled"; completed: number; total: number; message: string };
}

export interface ModelUsageRecord { inputTokens?: number; outputTokens?: number; totalTokens?: number; }
