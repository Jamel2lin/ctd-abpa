import { randomUUID } from "node:crypto";
import type { DataType, ExceptionRecord, ExpressionV2, PredicateV2, ProcessPlanV2, ProcessPlanV3, ProcessStepV2, RuleSetVersion, Scalar, TargetTemplateVersion, ValueOperand } from "@ctd-abpa/types";
import { ProcessPlanV2Schema, ProcessPlanV3Schema, RuleSetVersionSchema, TargetTemplateVersionSchema } from "@ctd-abpa/types";
import { parseLocalDate } from "./date.js";

export interface SourceTraceV2 { artifactId?: string; sourceFile: string; sourceSheet: string; sourceRow?: number; sourceColumn?: number; columnId?: string; }
export interface DataRowV2 { values: Record<string, Scalar>; lineage: SourceTraceV2[]; }
export interface DataSetV2 { columns: Record<string, DataType>; rows: DataRowV2[]; }
export interface StageReconciliationV2 { stepId: string; operator: ProcessStepV2["operator"]; inputRows: number; outputRows: number; isolatedRows: number; metrics: Record<string, number>; }
export interface ExecuteV2Result { data: DataSetV2; outputs: Record<string, DataSetV2>; rows: Scalar[][]; exceptions: ExceptionRecord[]; stages: StageReconciliationV2[]; reconciliation: { inputRows: number; filteredRows: number; isolatedRows: number; outputRows: number }; }
export interface ExecuteV2BranchResult { branchId: string; result?: ExecuteV2Result; structuralError?: string; }

class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
  constructor(numerator: bigint, denominator = 1n) {
    if (denominator === 0n) throw new Error("除零");
    const sign = denominator < 0n ? -1n : 1n;
    let a = numerator < 0n ? -numerator : numerator, b = denominator < 0n ? -denominator : denominator;
    while (b) [a, b] = [b, a % b];
    this.numerator = numerator * sign / a;
    this.denominator = denominator * sign / a;
  }
  static parse(value: unknown): Rational {
    const text = String(value ?? "").trim();
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw new Error(`非法十进制数: ${text || "空"}`);
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
    return new Rational(negative ? -numerator : numerator, denominator);
  }
  add(other: Rational): Rational { return new Rational(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator); }
  subtract(other: Rational): Rational { return this.add(new Rational(-other.numerator, other.denominator)); }
  multiply(other: Rational): Rational { return new Rational(this.numerator * other.numerator, this.denominator * other.denominator); }
  divide(other: Rational): Rational {
    if (other.numerator === 0n) throw new Error("除零");
    const sign = other.numerator < 0n ? -1n : 1n;
    return new Rational(this.numerator * other.denominator * sign, other.numerator * sign * this.denominator);
  }
  compare(other: Rational): number {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  round(scale: number): Rational {
    if (!Number.isInteger(scale) || scale < 0 || scale > 12) throw new Error("舍入位数必须是 0-12 的整数");
    const factor = 10n ** BigInt(scale), scaled = this.numerator * factor;
    let quotient = scaled / this.denominator, remainder = scaled % this.denominator;
    if (remainder < 0n) remainder = -remainder;
    if (remainder * 2n >= this.denominator) quotient += scaled < 0n ? -1n : 1n;
    return new Rational(quotient, factor);
  }
  toText(maxScale = 12): string {
    let denominator = this.denominator, twos = 0, fives = 0;
    while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
    while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
    const scale = Math.max(twos, fives);
    if (denominator !== 1n || scale > maxScale) throw new Error(`精度溢出，必须显式舍入到不超过 ${maxScale} 位`);
    const factor = 10n ** BigInt(scale), absolute = this.numerator < 0n ? -this.numerator : this.numerator;
    const scaled = absolute * factor / this.denominator, digits = scaled.toString().padStart(scale + 1, "0");
    const sign = this.numerator < 0n ? "-" : "";
    if (!scale) return `${sign}${digits}`;
    const text = `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    return text.replace(/\.?0+$/, "");
  }
}

function operandValue(operand: ValueOperand, row: DataRowV2, parameters: Record<string, Scalar> = {}): Scalar {
  if (operand.kind === "literal") return operand.value;
  if (operand.kind === "parameter") {
    if (!(operand.parameterId in parameters)) throw new Error(`参数不存在: ${operand.parameterId}`);
    return parameters[operand.parameterId];
  }
  if (!(operand.columnId in row.values)) throw new Error(`字段不存在: ${operand.columnId}`);
  return row.values[operand.columnId];
}

function compareValues(left: Scalar, right: Scalar, type: DataType = "text"): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (type === "integer" || type === "decimal") return Rational.parse(left).compare(Rational.parse(right));
  return String(left).localeCompare(String(right));
}

function predicateMatches(predicate: PredicateV2, row: DataRowV2, columns: Record<string, DataType>, parameters: Record<string, Scalar> = {}): boolean {
  if ("items" in predicate) return predicate.kind === "all" ? predicate.items.every((item) => predicateMatches(item, row, columns, parameters)) : predicate.items.some((item) => predicateMatches(item, row, columns, parameters));
  if ("item" in predicate) return !predicateMatches(predicate.item, row, columns, parameters);
  const left = operandValue(predicate.left, row, parameters), values = Array.isArray(predicate.right) ? predicate.right.map((item) => operandValue(item, row, parameters)) : [operandValue(predicate.right, row, parameters)];
  const type = predicate.left.kind === "column" ? columns[predicate.left.columnId] : "text";
  if (predicate.operator === "in") return values.some((right) => compareValues(left, right, type) === 0);
  if (predicate.operator === "between") return values.length === 2 && compareValues(left, values[0], type) >= 0 && compareValues(left, values[1], type) <= 0;
  if (values.length !== 1) throw new Error(`比较操作 ${predicate.operator} 只允许一个右值`);
  const compared = compareValues(left, values[0], type);
  return predicate.operator === "eq" ? compared === 0 : predicate.operator === "neq" ? compared !== 0 : predicate.operator === "gt" ? compared > 0 : predicate.operator === "gte" ? compared >= 0 : predicate.operator === "lt" ? compared < 0 : compared <= 0;
}

function evaluate(expression: ExpressionV2, row: DataRowV2, columns: Record<string, DataType>, parameters: Record<string, Scalar> = {}): Scalar | Rational {
  if (expression.kind === "column" || expression.kind === "literal" || expression.kind === "parameter") return operandValue(expression, row, parameters);
  if (expression.kind === "condition") return evaluate(predicateMatches(expression.when, row, columns, parameters) ? expression.then : expression.otherwise, row, columns, parameters);
  const values = expression.kind === "binary" ? [evaluate(expression.left, row, columns, parameters), evaluate(expression.right, row, columns, parameters)] : expression.arguments.map((item) => evaluate(item, row, columns, parameters));
  const decimals = values.map((value) => value instanceof Rational ? value : Rational.parse(value));
  if (expression.kind === "binary") {
    if (expression.operator === "add") return decimals[0].add(decimals[1]);
    if (expression.operator === "subtract") return decimals[0].subtract(decimals[1]);
    if (expression.operator === "multiply") return decimals[0].multiply(decimals[1]);
    return decimals[0].divide(decimals[1]);
  }
  if (expression.name === "round") {
    if (values.length !== 2) throw new Error("round 必须接收数值和位数两个参数");
    return decimals[0].round(Number(values[1] instanceof Rational ? values[1].toText(0) : values[1]));
  }
  if (!decimals.length) throw new Error(`${expression.name} 至少需要一个参数`);
  return decimals.reduce((selected, value) => expression.name === "min" ? (value.compare(selected) < 0 ? value : selected) : (value.compare(selected) > 0 ? value : selected));
}

function convert(value: Scalar | Rational, type: DataType, scale?: number): Scalar {
  if (value === null) return null;
  if (type === "text") return value instanceof Rational ? value.toText(scale ?? 12) : String(value);
  if (type === "decimal") return value instanceof Rational ? value.toText(scale ?? 12) : Rational.parse(value).toText(scale ?? 12);
  if (type === "integer") {
    const text = (value instanceof Rational ? value : Rational.parse(value)).toText(0), number = Number(text);
    if (!Number.isSafeInteger(number)) throw new Error("整数精度溢出");
    return number;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (["true", "1", "是"].includes(String(value).toLowerCase())) return true;
    if (["false", "0", "否"].includes(String(value).toLowerCase())) return false;
    throw new Error(`非法布尔值: ${value}`);
  }
  if (type === "date") return parseLocalDate(value).iso;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) throw new Error(`非法日期时间: ${text}`);
  parseLocalDate(text.slice(0, 10));
  const [hour, minute] = text.slice(11).split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error(`非法日期时间: ${text}`);
  return text;
}

function key(row: DataRowV2, columns: string[]): string { return JSON.stringify(columns.map((column) => row.values[column])); }
function mergeLineage(rows: DataRowV2[]): SourceTraceV2[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => row.lineage).filter((trace) => { const id = JSON.stringify(trace); if (seen.has(id)) return false; seen.add(id); return true; });
}
function isolated(step: ProcessStepV2, row: DataRowV2, reason: string, columnId?: string): ExceptionRecord {
  const first = row.lineage.find((trace) => trace.columnId === columnId) ?? row.lineage[0] ?? { sourceFile: "", sourceSheet: "" };
  return { id: randomUUID(), code: "V2_ROW_ISOLATED", severity: "error", businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "按规则输入字段归属", message: reason, sourceFile: first.sourceFile, sourceSheet: first.sourceSheet, sourceRow: first.sourceRow, sourceColumn: first.sourceColumn, columnId, originalValue: columnId ? row.values[columnId] : undefined, ruleId: step.stepId, reason, suggestion: "修正原值或规则后创建新运行版本重跑", raw: row.values, lineage: row.lineage };
}

function referencedColumnsInPredicate(predicate: PredicateV2): string[] {
  if ("items" in predicate) return predicate.items.flatMap(referencedColumnsInPredicate);
  if ("item" in predicate) return referencedColumnsInPredicate(predicate.item);
  return [predicate.left, ...(Array.isArray(predicate.right) ? predicate.right : [predicate.right])].filter((item): item is { kind: "column"; columnId: string } => item.kind === "column").map((item) => item.columnId);
}
function referencedColumnsInExpression(expression: ExpressionV2): string[] {
  if (expression.kind === "column") return [expression.columnId];
  if (expression.kind === "literal" || expression.kind === "parameter") return [];
  if (expression.kind === "binary") return [...referencedColumnsInExpression(expression.left), ...referencedColumnsInExpression(expression.right)];
  if (expression.kind === "function") return expression.arguments.flatMap(referencedColumnsInExpression);
  return [...referencedColumnsInPredicate(expression.when), ...referencedColumnsInExpression(expression.then), ...referencedColumnsInExpression(expression.otherwise)];
}
function referencedParametersInPredicate(predicate: PredicateV2): string[] {
  if ("items" in predicate) return predicate.items.flatMap(referencedParametersInPredicate);
  if ("item" in predicate) return referencedParametersInPredicate(predicate.item);
  return [predicate.left, ...(Array.isArray(predicate.right) ? predicate.right : [predicate.right])].filter((item): item is { kind: "parameter"; parameterId: string } => item.kind === "parameter").map((item) => item.parameterId);
}
function referencedParametersInExpression(expression: ExpressionV2): string[] {
  if (expression.kind === "parameter") return [expression.parameterId];
  if (expression.kind === "column" || expression.kind === "literal") return [];
  if (expression.kind === "binary") return [...referencedParametersInExpression(expression.left), ...referencedParametersInExpression(expression.right)];
  if (expression.kind === "function") return expression.arguments.flatMap(referencedParametersInExpression);
  return [...referencedParametersInPredicate(expression.when), ...referencedParametersInExpression(expression.then), ...referencedParametersInExpression(expression.otherwise)];
}
function requireColumns(columns: Record<string, DataType>, required: string[], stepId: string): void {
  const missing = [...new Set(required)].filter((column) => !(column in columns));
  if (missing.length) throw new Error(`步骤 ${stepId} 缺少字段: ${missing.join(", ")}`);
}

function compareOrderedRows(a: DataRowV2, b: DataRowV2, keys: Array<{ columnId: string; direction: "asc" | "desc"; nulls: "first" | "last" }>, columns: Record<string, DataType>): number {
  for (const item of keys) {
    const left = a.values[item.columnId], right = b.values[item.columnId];
    let compared = compareValues(left, right, columns[item.columnId]);
    if (left === null || right === null) compared = left === right ? 0 : left === null ? (item.nulls === "first" ? -1 : 1) : (item.nulls === "first" ? 1 : -1);
    if (compared) return item.direction === "asc" ? compared : -compared;
  }
  return (a.lineage[0]?.sourceRow ?? 0) - (b.lineage[0]?.sourceRow ?? 0);
}

export function preflightPlanV2(planInput: ProcessPlanV2 | ProcessPlanV3, bindings: Record<string, DataSetV2>, templateInput: TargetTemplateVersion): void {
  const plan = planInput.version === 3 ? ProcessPlanV3Schema.parse(planInput) : ProcessPlanV2Schema.parse(planInput), template = TargetTemplateVersionSchema.parse(templateInput);
  if (template.id !== plan.targetTemplate.id || template.version !== plan.targetTemplate.version) throw new Error("目标模板版本与计划不一致");
  const available = new Map<string, Record<string, DataType>>();
  const parameters = plan.version === 3 ? plan.parameters : {};
  const requireParameters = (ids: string[], stepId: string) => { const missing = [...new Set(ids)].filter((id) => !(id in parameters)); if (missing.length) throw new Error(`步骤 ${stepId} 缺少已确认参数: ${missing.join(", ")}`); };
  for (const input of plan.inputs) {
    const data = bindings[input.bindingId];
    if (!data) throw new Error(`缺少输入绑定: ${input.bindingId}`);
    requireColumns(data.columns, input.columns.map((column) => column.columnId), input.bindingId);
    available.set(input.bindingId, { ...data.columns });
  }
  for (const step of plan.steps) {
    const columns = { ...available.get(step.input)! };
    if (step.operator === "select") { requireColumns(columns, step.columns, step.stepId); available.set(step.stepId, Object.fromEntries(step.columns.map((column) => [column, columns[column]]))); continue; }
    if (step.operator === "rename") { requireColumns(columns, step.mappings.map((item) => item.from), step.stepId); for (const item of step.mappings) { if (item.to in columns && item.to !== item.from) throw new Error(`步骤 ${step.stepId} 重命名目标已存在: ${item.to}`); columns[item.to] = columns[item.from]; delete columns[item.from]; } }
    else if (step.operator === "convert") { requireColumns(columns, step.conversions.map((item) => item.columnId), step.stepId); for (const item of step.conversions) columns[item.columnId] = item.to; }
    else if (step.operator === "fill_null") requireColumns(columns, step.values.map((item) => item.columnId), step.stepId);
    else if (step.operator === "filter") { requireColumns(columns, referencedColumnsInPredicate(step.predicate), step.stepId); requireParameters(referencedParametersInPredicate(step.predicate), step.stepId); }
    else if (step.operator === "sort") requireColumns(columns, step.keys.map((item) => item.columnId), step.stepId);
    else if (step.operator === "deduplicate") requireColumns(columns, step.keys, step.stepId);
    else if (step.operator === "calculate") { for (const item of step.assignments) { requireColumns(columns, referencedColumnsInExpression(item.expression), step.stepId); requireParameters(referencedParametersInExpression(item.expression), step.stepId); columns[item.outputColumnId] = item.dataType; } }
    else if (step.operator === "allocate_balance") {
      requireColumns(columns, [...step.groupBy, step.balanceColumn, step.demandColumn, ...step.orderBy.map((item) => item.columnId)], step.stepId);
      if (columns[step.balanceColumn] !== "integer" || columns[step.demandColumn] !== "integer") throw new Error(`步骤 ${step.stepId} 的余额和需求必须是整数分钟`);
      const outputs = [step.allocatedColumn, step.fallbackColumn, step.remainingColumn];
      if (new Set(outputs).size !== outputs.length || outputs.some((column) => column in columns)) throw new Error(`步骤 ${step.stepId} 的分配输出字段必须唯一且尚不存在`);
      for (const output of outputs) columns[output] = "integer";
    }
    else if (step.operator === "split_rows") {
      const branchIds = step.branches.map((branch) => branch.branchId); if (new Set(branchIds).size !== branchIds.length) throw new Error(`步骤 ${step.stepId} 的拆分分支 ID 必须唯一`);
      for (const branch of step.branches) {
        requireColumns(columns, referencedColumnsInPredicate(branch.when), step.stepId); requireParameters(referencedParametersInPredicate(branch.when), step.stepId);
        for (const item of branch.assignments) { requireColumns(columns, referencedColumnsInExpression(item.expression), step.stepId); requireParameters(referencedParametersInExpression(item.expression), step.stepId); const existing = columns[item.outputColumnId]; if (existing && existing !== item.dataType) throw new Error(`步骤 ${step.stepId} 的拆分输出字段类型不一致: ${item.outputColumnId}`); columns[item.outputColumnId] = item.dataType; }
      }
    }
    else if (step.operator === "join") {
      const right = available.get(step.right)!; requireColumns(columns, step.leftKeys, step.stepId); requireColumns(right, step.rightKeys, step.stepId);
      for (const check of step.identityChecks) { requireColumns(columns, [check.left], step.stepId); requireColumns(right, [check.right], step.stepId); }
      for (const [column, type] of Object.entries(right)) if (!(column in columns)) columns[column] = type; else if (!step.rightKeys.includes(column)) throw new Error(`步骤 ${step.stepId} 关联字段冲突: ${column}，请先重命名`);
    } else if (step.operator === "aggregate") {
      for (const metric of step.metrics) {
        if (metric.function !== "count" && !metric.columnId) throw new Error(`步骤 ${step.stepId} 的 ${metric.function} 必须指定字段`);
        if (metric.function === "sum" && metric.columnId && !["integer", "decimal"].includes(columns[metric.columnId])) throw new Error(`步骤 ${step.stepId} 的求和字段必须为数值类型: ${metric.columnId}`);
      }
      requireColumns(columns, [...step.groupBy, ...step.metrics.flatMap((item) => item.columnId ? [item.columnId] : [])], step.stepId);
      const aggregateColumns: Record<string, DataType> = Object.fromEntries(step.groupBy.map((column) => [column, columns[column]]));
      for (const metric of step.metrics) aggregateColumns[metric.outputColumnId] = metric.function === "count" ? "integer" : columns[metric.columnId!];
      available.set(step.stepId, aggregateColumns); continue;
    }
    available.set(step.stepId, columns);
  }
  if (plan.version === 2 && template.sheets.length !== 1) throw new Error("V2 计划仅支持单工作表；请使用 V3 明确绑定每张输出表");
  const outputs = plan.version === 3 ? plan.outputs : [{ sheetId: template.sheets[0].sheetId, datasetId: plan.steps.at(-1)?.stepId ?? plan.inputs[0].bindingId }];
  if (outputs.length !== template.sheets.length) throw new Error("输出绑定数量与模板工作表数量不一致");
  for (const sheet of template.sheets) {
    const binding = outputs.find((output) => output.sheetId === sheet.sheetId);
    if (!binding) throw new Error(`模板工作表未绑定输出: ${sheet.sheetId}`);
    const output = available.get(binding.datasetId);
    if (!output) throw new Error(`输出数据集不存在: ${binding.datasetId}`);
    requireColumns(output, sheet.columns.map((column) => column.columnId), `targetTemplate.${sheet.sheetId}`);
  }
}

export function executePlanV2(args: { plan: ProcessPlanV2 | ProcessPlanV3; bindings: Record<string, DataSetV2>; rules: RuleSetVersion; template: TargetTemplateVersion; allowDraft?: boolean }): ExecuteV2Result {
  const plan = args.plan.version === 3 ? ProcessPlanV3Schema.parse(args.plan) : ProcessPlanV2Schema.parse(args.plan), rules = RuleSetVersionSchema.parse(args.rules), template = TargetTemplateVersionSchema.parse(args.template);
  const reusable = rules.status === "published", oneTimeApproved = rules.status === "confirmed", previewable = args.allowDraft && ["draft", "validated"].includes(rules.status);
  if ((!reusable && !oneTimeApproved && !previewable) || rules.id !== plan.rules.id || rules.version !== plan.rules.version) throw new Error("规则必须是已发布版本或本次运行已确认修订；草稿和已校验修订只能预演");
  if (JSON.stringify(rules.steps) !== JSON.stringify(plan.steps)) throw new Error("计划步骤与固定规则版本不一致");
  preflightPlanV2(plan, args.bindings, template);
  const data = new Map<string, DataSetV2>(Object.entries(args.bindings).map(([id, set]) => [id, { columns: { ...set.columns }, rows: set.rows.map((row) => ({ values: { ...row.values }, lineage: [...row.lineage] })) }]));
  const exceptions: ExceptionRecord[] = [];
  const stages: StageReconciliationV2[] = [];
  const parameters = plan.version === 3 ? plan.parameters : {};
  let filteredRows = 0;
  for (const step of plan.steps) {
    const source = data.get(step.input)!, columns = { ...source.columns }; let rows = source.rows;
    const inputRows = rows.length, exceptionStart = exceptions.length, metrics: Record<string, number> = {};
    if (step.operator === "select") { rows = rows.map((row) => ({ ...row, values: Object.fromEntries(step.columns.map((column) => [column, row.values[column]])) })); data.set(step.stepId, { columns: Object.fromEntries(step.columns.map((column) => [column, columns[column]])), rows }); stages.push({ stepId: step.stepId, operator: step.operator, inputRows, outputRows: rows.length, isolatedRows: 0, metrics: { selectedColumns: step.columns.length } }); continue; }
    if (step.operator === "rename") {
      for (const item of step.mappings) { columns[item.to] = columns[item.from]; delete columns[item.from]; }
      rows = rows.map((row) => { const values = { ...row.values }; for (const item of step.mappings) { values[item.to] = values[item.from]; delete values[item.from]; } return { ...row, values }; });
    }
    else if (step.operator === "fill_null") rows = rows.map((row) => ({ ...row, values: { ...row.values, ...Object.fromEntries(step.values.filter((item) => row.values[item.columnId] === null).map((item) => [item.columnId, item.value])) } }));
    else if (step.operator === "filter") { const before = rows.length; rows = rows.filter((row) => predicateMatches(step.predicate, row, columns, parameters)); filteredRows += before - rows.length; metrics.filteredRows = before - rows.length; }
    else if (step.operator === "convert" || step.operator === "calculate") {
      const accepted: DataRowV2[] = [];
      for (const row of rows) { let failingColumn: string | undefined; try {
        const values = { ...row.values };
        if (step.operator === "convert") for (const item of step.conversions) { failingColumn = item.columnId; try { values[item.columnId] = convert(values[item.columnId], item.to); columns[item.columnId] = item.to; } catch (error) { if (item.onError === "null") values[item.columnId] = null; else throw error; } }
        else for (const item of step.assignments) { failingColumn = item.outputColumnId; values[item.outputColumnId] = convert(evaluate(item.expression, { ...row, values }, columns, parameters), item.dataType, item.scale); columns[item.outputColumnId] = item.dataType; }
        accepted.push({ ...row, values });
      } catch (error) { exceptions.push(isolated(step, row, (error as Error).message, failingColumn)); } }
      rows = accepted;
    } else if (step.operator === "sort") rows = [...rows].sort((a, b) => compareOrderedRows(a, b, step.keys, columns));
    else if (step.operator === "deduplicate") {
      const groups = new Map<string, DataRowV2[]>(); for (const row of rows) { const group = groups.get(key(row, step.keys)) ?? []; group.push(row); groups.set(key(row, step.keys), group); }
      rows = [...groups.values()].flatMap((group) => { if (group.length === 1) return group; if (step.keep === "isolate_all") { exceptions.push(...group.map((row) => isolated(step, row, "去重键重复"))); return []; } return [step.keep === "first" ? group[0] : group.at(-1)!]; });
    } else if (step.operator === "aggregate") {
      const groups = new Map<string, DataRowV2[]>();
      for (const row of rows) {
        const invalid = step.metrics.find((metric) => {
          if (metric.function === "count") return false;
          const value = row.values[metric.columnId!];
          if (value === null || value === undefined || value === "") return true;
          if (metric.function !== "sum") return false;
          try { Rational.parse(value); return false; } catch { return true; }
        });
        if (invalid) { exceptions.push(isolated(step, row, `聚合字段无效: ${invalid.columnId}`, invalid.columnId)); continue; }
        const group = groups.get(key(row, step.groupBy)) ?? []; group.push(row); groups.set(key(row, step.groupBy), group);
      }
      rows = [...groups.values()].flatMap((group) => {
        try {
          const values: Record<string, Scalar> = Object.fromEntries(step.groupBy.map((column) => [column, group[0].values[column]]));
          for (const metric of step.metrics) {
            if (metric.function === "count") values[metric.outputColumnId] = group.length;
            else if (metric.function === "sum") values[metric.outputColumnId] = group.reduce((total, row) => total.add(Rational.parse(row.values[metric.columnId!])), new Rational(0n)).toText();
            else values[metric.outputColumnId] = group.map((row) => row.values[metric.columnId!]).reduce((selected, value) => metric.function === "min" ? (compareValues(value, selected, columns[metric.columnId!]) < 0 ? value : selected) : (compareValues(value, selected, columns[metric.columnId!]) > 0 ? value : selected));
          }
          return [{ values, lineage: mergeLineage(group) }];
        } catch (error) {
          exceptions.push(...group.map((row) => isolated(step, row, `聚合分组失败: ${(error as Error).message}`)));
          return [];
        }
      });
      const aggregateColumns: Record<string, DataType> = Object.fromEntries(step.groupBy.map((column) => [column, columns[column]]));
      for (const metric of step.metrics) aggregateColumns[metric.outputColumnId] = metric.function === "count" ? "integer" : columns[metric.columnId!];
      for (const column of Object.keys(columns)) delete columns[column]; Object.assign(columns, aggregateColumns);
      metrics.groupRows = rows.length;
    } else if (step.operator === "allocate_balance") {
      const groups = new Map<string, DataRowV2[]>();
      for (const row of rows) { const group = groups.get(key(row, step.groupBy)) ?? []; group.push(row); groups.set(key(row, step.groupBy), group); }
      const allocated: DataRowV2[] = [];
      for (const group of groups.values()) {
        const accepted: DataRowV2[] = [];
        let opening: number | undefined;
        for (const row of group) {
          try {
            const balance = convert(row.values[step.balanceColumn], "integer") as number, demand = convert(row.values[step.demandColumn], "integer") as number;
            if (balance < 0 || demand < 0) throw new Error("余额和需求分钟不能为负数");
            if (opening === undefined) opening = balance;
            else if (opening !== balance) throw new Error("同一分配组存在不一致的初始余额");
            accepted.push(row);
          } catch (error) { exceptions.push(isolated(step, row, (error as Error).message)); }
        }
        let remaining = opening ?? 0;
        for (const row of [...accepted].sort((a, b) => compareOrderedRows(a, b, step.orderBy, columns))) {
          const demand = convert(row.values[step.demandColumn], "integer") as number;
          const used = Math.min(demand, remaining), fallback = demand - used;
          remaining -= used;
          allocated.push({ ...row, values: { ...row.values, [step.allocatedColumn]: used, [step.fallbackColumn]: fallback, [step.remainingColumn]: remaining } });
        }
      }
      rows = allocated;
      columns[step.allocatedColumn] = "integer"; columns[step.fallbackColumn] = "integer"; columns[step.remainingColumn] = "integer";
      metrics.allocatedMinutes = rows.reduce((sum, row) => sum + Number(row.values[step.allocatedColumn] ?? 0), 0);
      metrics.fallbackMinutes = rows.reduce((sum, row) => sum + Number(row.values[step.fallbackColumn] ?? 0), 0);
    } else if (step.operator === "split_rows") {
      const split: DataRowV2[] = [];
      for (const branch of step.branches) metrics[`branch.${branch.branchId}.rows`] = 0;
      for (const row of rows) for (const branch of step.branches) if (predicateMatches(branch.when, row, columns, parameters)) {
        let failingColumn: string | undefined;
        try {
          const values = { ...row.values };
          for (const item of branch.assignments) { failingColumn = item.outputColumnId; values[item.outputColumnId] = convert(evaluate(item.expression, { ...row, values }, columns, parameters), item.dataType, item.scale); columns[item.outputColumnId] = item.dataType; }
          split.push({ ...row, values }); metrics[`branch.${branch.branchId}.rows`]++;
        } catch (error) { exceptions.push(isolated(step, row, `拆分分支 ${branch.branchId} 失败: ${(error as Error).message}`, failingColumn)); }
      }
      rows = split;
    } else if (step.operator === "join") {
      const right = data.get(step.right)!, rightGroups = new Map<string, DataRowV2[]>();
      metrics.rightRows = right.rows.length; metrics.matchedRows = 0; metrics.unmatchedRows = 0; metrics.cardinalityErrors = 0; metrics.identityConflicts = 0;
      for (const row of right.rows) { if (step.rightKeys.some((column) => row.values[column] === null || row.values[column] === "")) continue; const group = rightGroups.get(key(row, step.rightKeys)) ?? []; group.push(row); rightGroups.set(key(row, step.rightKeys), group); }
      const leftCounts = new Map<string, number>(); for (const row of rows) if (!step.leftKeys.some((column) => row.values[column] === null || row.values[column] === "")) leftCounts.set(key(row, step.leftKeys), (leftCounts.get(key(row, step.leftKeys)) ?? 0) + 1);
      const joined: DataRowV2[] = [];
      for (const row of rows) {
        const matches = step.leftKeys.some((column) => row.values[column] === null || row.values[column] === "") ? [] : rightGroups.get(key(row, step.leftKeys)) ?? [];
        if (matches.length > 1 || (step.cardinality === "one_to_one" && (leftCounts.get(key(row, step.leftKeys)) ?? 0) > 1)) { metrics.cardinalityErrors++; exceptions.push(isolated(step, row, "关联键违反声明的基数")); continue; }
        if (!matches.length) { metrics.unmatchedRows++; if (step.joinType === "left") joined.push({ ...row, values: { ...Object.fromEntries(Object.keys(right.columns).map((column) => [column, null])), ...row.values } }); else filteredRows++; continue; }
        const match = matches[0];
        if (step.identityChecks.some((check) => compareValues(row.values[check.left], match.values[check.right], columns[check.left]) !== 0)) { metrics.identityConflicts++; exceptions.push(isolated(step, row, "关联身份校验冲突")); continue; }
        metrics.matchedRows++; joined.push({ values: { ...match.values, ...row.values }, lineage: mergeLineage([row, match]) });
      }
      rows = joined; for (const [column, type] of Object.entries(right.columns)) if (!(column in columns)) columns[column] = type;
    }
    data.set(step.stepId, { columns, rows });
    stages.push({ stepId: step.stepId, operator: step.operator, inputRows, outputRows: rows.length, isolatedRows: exceptions.length - exceptionStart, metrics });
  }
  const bindings = plan.version === 3 ? plan.outputs : [{ sheetId: template.sheets[0].sheetId, datasetId: plan.steps.at(-1)?.stepId ?? plan.inputs[0].bindingId }];
  const outputs = Object.fromEntries(bindings.map((binding) => [binding.sheetId, data.get(binding.datasetId)!]));
  const result = outputs[template.sheets[0].sheetId], sheet = template.sheets[0];
  const outputRows = result.rows.map((row) => sheet.columns.map((column) => row.values[column.columnId] ?? column.defaultValue ?? null));
  const inputRows = plan.inputs.reduce((sum, input) => sum + args.bindings[input.bindingId].rows.length, 0);
  return { data: result, outputs, rows: outputRows, exceptions, stages, reconciliation: { inputRows, filteredRows, isolatedRows: exceptions.length, outputRows: Object.values(outputs).reduce((count, output) => count + output.rows.length, 0) } };
}

export function executePlanBranchesV2(branches: Array<{ branchId: string; plan: ProcessPlanV2 | ProcessPlanV3; bindings: Record<string, DataSetV2>; rules: RuleSetVersion; template: TargetTemplateVersion }>): ExecuteV2BranchResult[] {
  return branches.map(({ branchId, ...args }) => {
    try { return { branchId, result: executePlanV2(args) }; }
    catch (error) { return { branchId, structuralError: (error as Error).message }; }
  });
}
