import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { combineLocalDateTime, compareLocalDateTime, decimalHoursToMinutes, decimalMultiplyToInteger, employeeId, executePlanV2, matchFields, minutesToHoursText, parseLocalDate, requireFields, safeSpreadsheetText, type DataSetV2, type StageReconciliationV2 } from "@ctd-abpa/core";
import { ProcessPlanV3Schema, SettlementRuleSchema, type ExceptionBusinessLevel, type ExceptionDisposition, type ExceptionRecord, type FilterSpec, type NormalizedRow, type ProcessPlan, type ProcessStepV2, type RuleSetVersion, type SettlementRule, type TargetTemplateVersion } from "@ctd-abpa/types";
import { readTabularSheet, readWorkbook, type CellValue } from "./workbook.js";

export interface SourcePatch { sourcePath: string; sourceSheet: string; sourceRow: number; sourceIndex?: number; action: "correct" | "exclude"; value?: CellValue; }
function patchedTab<T extends ReturnType<typeof readTabularSheet>>(tab: T, path: string, patches: SourcePatch[]): T {
  const relevant = patches.filter((patch) => patch.sourcePath === path && patch.sourceSheet === tab.name);
  if (!relevant.length) return tab;
  const rows: CellValue[][] = [], sourceRows: number[] = [];
  tab.rows.forEach((original, index) => {
    const sourceRow = tab.sourceRows[index], rowPatches = relevant.filter((patch) => patch.sourceRow === sourceRow);
    if (rowPatches.some((patch) => patch.action === "exclude")) return;
    const cells = [...original];
    for (const patch of rowPatches) if (patch.action === "correct") {
      if (patch.sourceIndex === undefined || patch.sourceIndex >= tab.headers.length) throw new Error("源列补丁位置无效");
      cells[patch.sourceIndex] = patch.value ?? null;
    }
    rows.push(cells); sourceRows.push(sourceRow);
  });
  for (const patch of relevant) if (!tab.sourceRows.includes(patch.sourceRow)) throw new Error(`源行补丁位置无效: ${patch.sourceRow}`);
  return { ...tab, rows, sourceRows };
}

export const OVERTIME_HEADERS = ["工号", "姓名", "部门", "职位", "起始日期", "申请加班"];
export const LEAVE_HEADERS = ["工号", "姓名", "部门", "缺勤类别", "起始时间", "终止时间", "合计小时", "免打卡"];

export interface OutputRow { cells: string[]; sourceRow: number; documentNo?: string; employeeId?: string; minutes?: number; }
export interface BalanceAuditRow { employeeId: string; name: string; department: string; openingMinutes: number; deductedMinutes: number; closingMinutes: number; balanceAsOf: string; }
export interface ProcessResult {
  sheetName: string; headers: string[]; rows: OutputRow[]; exceptions: ExceptionRecord[];
  balanceAudit: BalanceAuditRow[]; summary: Record<string, number>; sourceCount: number; stages?: StageReconciliationV2[];
}

function value(row: CellValue[], map: Record<string, number>, field: string): CellValue { return row[map[field]] ?? null; }
const exceptionGovernance: Record<string, { businessLevel: ExceptionBusinessLevel; disposition: ExceptionDisposition; requiresHumanReview: boolean; automationAllowed: boolean; sourceOfTruth: string; suggestion?: string }> = {
  OT_NEGATIVE_HOURS: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "ERP", suggestion: "核对 ERP 原单、冲销单或录入错误；保持隔离，不自动修正" },
  OT_ZERO_HOURS: { businessLevel: "L2", disposition: "rule_based", requiresHumanReview: false, automationAllowed: true, sourceOfTruth: "ERP", suggestion: "按已确认的零工时规则保留并提示" },
  IDENTITY_NAME_CONFLICT: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "HR Master Data", suggestion: "依据 HR Master Data、有效期和工号复用情况人工核实；禁止自动关联或更名" },
  ROW_INVALID: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "按字段归属", suggestion: "核对原始字段并修正后重跑；不得猜测缺失或非法值" },
  LEAVE_DOCUMENT_DUPLICATE: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "OA", suggestion: "依据 OA 审批单 ID 和最终状态确认有效记录" },
  BALANCE_MISSING: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "HR Master Data" },
  BALANCE_DUPLICATE: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "HR Master Data" },
  BALANCE_IDENTITY_CONFLICT: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "HR Master Data" },
  BALANCE_INVALID: { businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "HR Master Data" },
};

function exception(code: string, severity: "warning" | "error", message: string, path: string, sheet: string, row: number, raw: Record<string, unknown>, id?: string): ExceptionRecord {
  const governance = exceptionGovernance[code] ?? { businessLevel: "L3" as const, disposition: "alert_and_isolate" as const, requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "按字段归属" };
  return { id: randomUUID(), code, severity, ...governance, message, sourceFile: basename(path), sourceSheet: sheet, sourceRow: row, employeeId: id, raw, reason: message, suggestion: governance.suggestion ?? "修正源数据或规则后创建新运行版本重跑", lineage: [{ sourceFile: basename(path), sourceSheet: sheet, sourceRow: row }] };
}
function rawObject(headers: string[], row: CellValue[]): Record<string, unknown> { return Object.fromEntries(headers.map((h, i) => [h || `列${i + 1}`, row[i]])); }

function filterRowsV3(args: { id: string; rows: Array<{ sourceRow: number; sourceFile: string; sourceSheet: string; values: Record<string, string | number> }>; columns: DataSetV2["columns"]; filters: FilterSpec[]; outputColumns?: TargetTemplateVersion["sheets"][number]["columns"] }): { rows: DataSetV2["rows"]; sourceRows: Set<number>; stages: StageReconciliationV2[] } {
  const columns = { ...args.columns, source_row: "integer" as const };
  const data: DataSetV2 = { columns, rows: args.rows.map((row) => ({ values: { ...row.values, source_row: row.sourceRow }, lineage: [{ sourceFile: row.sourceFile, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow }] })) };
  const predicate = (filter: FilterSpec) => ({ kind: "compare" as const, operator: filter.operator, left: { kind: "column" as const, columnId: filter.field }, right: Array.isArray(filter.value) ? filter.value.map((value) => ({ kind: "literal" as const, value })) : { kind: "literal" as const, value: filter.value } });
  const steps: ProcessStepV2[] = args.filters.length
    ? [{ stepId: `${args.id}.filter`, input: "source", operator: "filter", predicate: args.filters.length === 1 ? predicate(args.filters[0]) : { kind: "all", items: args.filters.map(predicate) } }]
    : [{ stepId: `${args.id}.select`, input: "source", operator: "select", columns: Object.keys(columns) }];
  const datasetId = steps[0].stepId;
  const plan = ProcessPlanV3Schema.parse({ version: 3, planId: `compat.${args.id}`, revision: 1, rules: { id: `compat.${args.id}`, version: 1 }, inputs: [{ bindingId: "source", artifactId: "compat-source", sheetId: "compat-source", headerRows: [1], columns: Object.keys(columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) }], steps, targetTemplate: { id: `compat.${args.id}`, version: 1 }, parameters: {}, outputs: [{ sheetId: "result", datasetId }] });
  const rules: RuleSetVersion = { id: `compat.${args.id}`, version: 1, name: `${args.id} V3 兼容规则`, status: "published", aliases: {}, steps: plan.steps, scope: { kind: "source", sourceIdentity: args.id }, validatorVersion: "v3" };
  const template: TargetTemplateVersion = { id: `compat.${args.id}`, version: 1, format: "xlsx", sheets: [{ sheetId: "result", name: "筛选结果", headerRow: 1, columns: args.outputColumns ?? [{ columnId: "source_row", header: "源行", dataType: "integer", required: true }] }] };
  const result = executePlanV2({ plan, bindings: { source: data }, rules, template });
  return { rows: result.data.rows, sourceRows: new Set(result.data.rows.map((row) => Number(row.values.source_row))), stages: result.stages };
}

export async function processOvertime(path: string, filters: FilterSpec[] = [], patches: SourcePatch[] = [], aliases: Record<string, string[]> = {}): Promise<ProcessResult> {
  const tab = patchedTab(readTabularSheet(await readWorkbook(path)), path, patches);
  const map = matchFields(tab.headers, aliases); requireFields(map, ["employeeId", "name", "department", "position", "startDate", "overtimeHours"]);
  const exceptions: ExceptionRecord[] = [], normalized: Array<NormalizedRow<Record<string, string | number>> & { minutes: number }> = [];
  const names = new Map<string, Set<string>>();
  tab.rows.forEach((row, i) => {
    const raw = rawObject(tab.headers, row), sourceRow = tab.sourceRows[i];
    try {
      const id = employeeId(value(row, map, "employeeId")), name = String(value(row, map, "name") ?? "").trim();
      const department = String(value(row, map, "department") ?? "").trim(), position = String(value(row, map, "position") ?? "").trim();
      const startDateRaw = String(value(row, map, "startDate") ?? "").trim(), startDate = parseLocalDate(startDateRaw).iso;
      const hoursRaw = String(value(row, map, "overtimeHours") ?? "").trim(), minutes = decimalHoursToMinutes(hoursRaw);
      if (minutes < 0) { exceptions.push(exception("OT_NEGATIVE_HOURS", "error", "加班工时为负数，已隔离并提醒人工复核", path, tab.name, sourceRow, raw, id)); return; }
      if (minutes === 0) exceptions.push(exception("OT_ZERO_HOURS", "warning", "加班工时为零，已保留", path, tab.name, sourceRow, raw, id));
      const set = names.get(id) ?? new Set<string>(); set.add(name); names.set(id, set);
      normalized.push({ sourceFile: basename(path), sourceSheet: tab.name, sourceRow, raw, value: { employeeId: id, name, department, position, startDate, startDateRaw, hoursRaw }, minutes });
    } catch (error) { exceptions.push(exception("ROW_INVALID", "error", (error as Error).message, path, tab.name, sourceRow, raw)); }
  });
  const conflicted = new Set([...names].filter(([, set]) => set.size > 1).map(([id]) => id));
  const candidates = normalized.filter((item) => {
    const id = String(item.value.employeeId);
    if (!conflicted.has(id)) return true;
    exceptions.push(exception("IDENTITY_NAME_CONFLICT", "error", "同一工号对应多个姓名，该工号记录已隔离并提醒人工复核", path, tab.name, item.sourceRow, item.raw, id)); return false;
  });
  const selected = filterRowsV3({ id: "erp-overtime", rows: candidates.map((item) => ({ sourceRow: item.sourceRow, sourceFile: item.sourceFile, sourceSheet: item.sourceSheet, values: { employeeId: String(item.value.employeeId), name: String(item.value.name), department: String(item.value.department), position: String(item.value.position), startDate: String(item.value.startDate), minutes: item.minutes, employee_id: String(item.value.employeeId), employee_name: String(item.value.name), start_date: String(item.value.startDateRaw), overtime_hours: String(item.value.hoursRaw) } })), columns: { employeeId: "text", name: "text", department: "text", position: "text", startDate: "date", minutes: "integer", employee_id: "text", employee_name: "text", start_date: "text", overtime_hours: "text" }, filters, outputColumns: [
    { columnId: "employee_id", header: "工号", dataType: "text", required: true }, { columnId: "employee_name", header: "姓名", dataType: "text", required: true }, { columnId: "department", header: "部门", dataType: "text", required: true }, { columnId: "position", header: "职位", dataType: "text", required: true }, { columnId: "start_date", header: "起始日期", dataType: "text", required: true }, { columnId: "overtime_hours", header: "申请加班", dataType: "text", required: true },
  ] });
  const rows: OutputRow[] = selected.rows.map((row) => ({ sourceRow: Number(row.values.source_row), employeeId: String(row.values.employee_id), minutes: Number(row.values.minutes), cells: ["employee_id", "employee_name", "department", "position", "start_date", "overtime_hours"].map((column) => safeSpreadsheetText(row.values[column])) }));
  return { sheetName: tab.name, headers: OVERTIME_HEADERS, rows, exceptions, balanceAudit: [], sourceCount: tab.rows.length, stages: selected.stages, summary: { outputRows: rows.length, isolatedRows: exceptions.filter((e) => e.severity === "error").length, warningRows: exceptions.filter((e) => e.severity === "warning").length, humanReviewRows: exceptions.filter((e) => e.requiresHumanReview).length, automationBlockedRows: exceptions.filter((e) => !e.automationAllowed).length } };
}

interface LeaveRow { employeeId: string; name: string; department: string; leaveType: string; start: string; end: string; documentNo: string; minutes: number; sourceRow: number; raw: Record<string, unknown>; }
async function readLeaves(path: string, minutesPerDay = 480, patches: SourcePatch[] = [], aliases: Record<string, string[]> = {}): Promise<{ tabName: string; rows: LeaveRow[]; exceptions: ExceptionRecord[]; sourceCount: number }> {
  const tab = patchedTab(readTabularSheet(await readWorkbook(path)), path, patches);
  const map = matchFields(tab.headers, aliases); requireFields(map, ["employeeId", "name", "department", "leaveType", "startDate", "startTime", "endDate", "endTime", "hours", "days", "documentNo"]);
  const rows: LeaveRow[] = [], exceptions: ExceptionRecord[] = [];
  tab.rows.forEach((row, i) => {
    const raw = rawObject(tab.headers, row), sourceRow = tab.sourceRows[i];
    try {
      const id = employeeId(value(row, map, "employeeId"));
      const minutes = decimalHoursToMinutes(value(row, map, "hours")) + decimalMultiplyToInteger(value(row, map, "days"), minutesPerDay);
      if (minutes < 0) throw new Error("请假时长不能为负数");
      const name = String(value(row, map, "name") ?? "").trim(), department = String(value(row, map, "department") ?? "").trim(), leaveType = String(value(row, map, "leaveType") ?? "").trim(), documentNo = String(value(row, map, "documentNo") ?? "").trim();
      if (!name || !department || !leaveType || !documentNo) throw new Error("姓名、部门、请假类型和单据编号均为必填值");
      const start = combineLocalDateTime(value(row, map, "startDate"), value(row, map, "startTime")), end = combineLocalDateTime(value(row, map, "endDate"), value(row, map, "endTime"));
      if (compareLocalDateTime(start, end) > 0) throw new Error("请假起始时间晚于终止时间");
      rows.push({ employeeId: id, name, department, leaveType, start, end, documentNo, minutes, sourceRow, raw });
    } catch (error) { exceptions.push(exception("ROW_INVALID", "error", (error as Error).message, path, tab.name, sourceRow, raw)); }
  });
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.documentNo, (counts.get(r.documentNo) ?? 0) + 1));
  const validRows = rows.filter((r) => {
    if (r.documentNo && counts.get(r.documentNo) === 1) return true;
    exceptions.push(exception("LEAVE_DOCUMENT_DUPLICATE", "error", "单据编号为空或重复", path, tab.name, r.sourceRow, r.raw, r.employeeId));
    return false;
  });
  return { tabName: tab.name, rows: validRows, exceptions, sourceCount: tab.rows.length };
}

function leaveOutput(row: LeaveRow, type: string, minutes = row.minutes): OutputRow {
  return { sourceRow: row.sourceRow, documentNo: row.documentNo, employeeId: row.employeeId, minutes, cells: [row.employeeId, row.name, row.department, type, row.start, row.end, minutesToHoursText(minutes), "是"].map(safeSpreadsheetText) };
}

export async function processLeave(path: string, filters: FilterSpec[] = [], patches: SourcePatch[] = [], aliases: Record<string, string[]> = {}): Promise<ProcessResult> {
  const source = await readLeaves(path, 480, patches, aliases);
  const selected = filterRowsV3({ id: "oa-leave", rows: source.rows.map((row) => ({ sourceRow: row.sourceRow, sourceFile: basename(path), sourceSheet: source.tabName, values: { employeeId: row.employeeId, name: row.name, department: row.department, leaveType: row.leaveType, startDate: row.start.slice(0, 10), minutes: row.minutes, documentNo: row.documentNo, employee_id: row.employeeId, employee_name: row.name, leave_type: row.leaveType, start_at: row.start, end_at: row.end, total_hours: minutesToHoursText(row.minutes), attendance_exempt: "是" } })), columns: { employeeId: "text", name: "text", department: "text", leaveType: "text", startDate: "date", minutes: "integer", documentNo: "text", employee_id: "text", employee_name: "text", leave_type: "text", start_at: "text", end_at: "text", total_hours: "text", attendance_exempt: "text" }, filters, outputColumns: [
    { columnId: "employee_id", header: "工号", dataType: "text", required: true }, { columnId: "employee_name", header: "姓名", dataType: "text", required: true }, { columnId: "department", header: "部门", dataType: "text", required: true }, { columnId: "leave_type", header: "缺勤类别", dataType: "text", required: true }, { columnId: "start_at", header: "起始时间", dataType: "text", required: true }, { columnId: "end_at", header: "终止时间", dataType: "text", required: true }, { columnId: "total_hours", header: "合计小时", dataType: "text", required: true }, { columnId: "attendance_exempt", header: "免打卡", dataType: "text", required: true },
  ] });
  const rows: OutputRow[] = selected.rows.map((row) => ({ sourceRow: Number(row.values.source_row), documentNo: String(row.values.documentNo), employeeId: String(row.values.employee_id), minutes: Number(row.values.minutes), cells: ["employee_id", "employee_name", "department", "leave_type", "start_at", "end_at", "total_hours", "attendance_exempt"].map((column) => safeSpreadsheetText(row.values[column])) }));
  return { sheetName: "导入HR 格式", headers: LEAVE_HEADERS, rows, exceptions: source.exceptions, balanceAudit: [], sourceCount: source.sourceCount, stages: selected.stages, summary: { outputRows: rows.length, totalMinutes: rows.reduce((s, r) => s + (r.minutes ?? 0), 0), isolatedRows: source.exceptions.length } };
}

function detectBalanceAsOf(sheetName: string, firstHeaderCell: string): string {
  const year = /(20\d{2})年/.exec(firstHeaderCell)?.[1];
  const month = /(\d{1,2})月/.exec(firstHeaderCell)?.[1] ?? /(\d{1,2})月/.exec(sheetName)?.[1];
  if (!year || !month) throw new Error("无法自动识别年假余额月份");
  return `${year}-${String(Number(month)).padStart(2, "0")}`;
}

export interface AnnualSettlementOptions { allowStaleBalance?: boolean; filters?: FilterSpec[]; settlement?: Partial<SettlementRule>; patches?: SourcePatch[]; aliasesByPath?: Record<string, Record<string, string[]>>; }

function allocateSettlementV3(items: Array<{ leave: LeaveRow; openingMinutes: number }>): { allocations: Map<number, { annual: number; personal: number }>; stages: StageReconciliationV2[] } {
  const columns: DataSetV2["columns"] = { employee_id: "text", source_row: "integer", start_at: "datetime", document_no: "text", opening_minutes: "integer", demand_minutes: "integer" };
  const data: DataSetV2 = { columns, rows: items.map(({ leave, openingMinutes }) => ({
    values: { employee_id: leave.employeeId, source_row: leave.sourceRow, start_at: leave.start, document_no: leave.documentNo, opening_minutes: openingMinutes, demand_minutes: leave.minutes },
    lineage: [{ sourceFile: "", sourceSheet: "", sourceRow: leave.sourceRow }],
  })) };
  const steps: ProcessStepV2[] = [
    { stepId: "allocate", input: "leave", operator: "allocate_balance", groupBy: ["employee_id"], balanceColumn: "opening_minutes", demandColumn: "demand_minutes", orderBy: [{ columnId: "start_at", direction: "asc", nulls: "last" }, { columnId: "document_no", direction: "asc", nulls: "last" }, { columnId: "source_row", direction: "asc", nulls: "last" }], allocatedColumn: "annual_minutes", fallbackColumn: "personal_minutes", remainingColumn: "remaining_minutes" },
    { stepId: "split", input: "allocate", operator: "split_rows", branches: [
      { branchId: "annual", when: { kind: "compare", operator: "gt", left: { kind: "column", columnId: "annual_minutes" }, right: { kind: "literal", value: 0 } }, assignments: [{ outputColumnId: "allocation_kind", dataType: "text", expression: { kind: "literal", value: "annual" } }, { outputColumnId: "output_minutes", dataType: "integer", expression: { kind: "column", columnId: "annual_minutes" } }] },
      { branchId: "personal", when: { kind: "compare", operator: "gt", left: { kind: "column", columnId: "personal_minutes" }, right: { kind: "literal", value: 0 } }, assignments: [{ outputColumnId: "allocation_kind", dataType: "text", expression: { kind: "literal", value: "personal" } }, { outputColumnId: "output_minutes", dataType: "integer", expression: { kind: "column", columnId: "personal_minutes" } }] },
      { branchId: "zero", when: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "demand_minutes" }, right: { kind: "literal", value: 0 } }, assignments: [{ outputColumnId: "allocation_kind", dataType: "text", expression: { kind: "literal", value: "personal" } }, { outputColumnId: "output_minutes", dataType: "integer", expression: { kind: "literal", value: 0 } }] },
    ] },
  ];
  const plan = ProcessPlanV3Schema.parse({ version: 3, planId: "compat.annual-settlement", revision: 1, rules: { id: "compat.annual-settlement", version: 1 }, inputs: [{ bindingId: "leave", artifactId: "compat-leave", sheetId: "compat-leave", headerRows: [1], columns: Object.keys(columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) }], steps, targetTemplate: { id: "compat.annual-settlement", version: 1 }, parameters: {}, outputs: [{ sheetId: "result", datasetId: "split" }] });
  const rules: RuleSetVersion = { id: "compat.annual-settlement", version: 1, name: "年假结算 V3 兼容规则", status: "published", aliases: {}, steps: plan.steps, scope: { kind: "source", sourceIdentity: "oa:leave" }, validatorVersion: "v3" };
  const template: TargetTemplateVersion = { id: "compat.annual-settlement", version: 1, format: "xlsx", sheets: [{ sheetId: "result", name: "结算", headerRow: 1, columns: [{ columnId: "source_row", header: "源行", dataType: "integer", required: true }, { columnId: "allocation_kind", header: "分配类型", dataType: "text", required: true }, { columnId: "output_minutes", header: "分钟", dataType: "integer", required: true }] }] };
  const result = executePlanV2({ plan, bindings: { leave: data }, rules, template });
  const allocations = new Map<number, { annual: number; personal: number }>();
  for (const row of result.data.rows) {
    const sourceRow = Number(row.values.source_row), current = allocations.get(sourceRow) ?? { annual: 0, personal: 0 };
    current[row.values.allocation_kind === "annual" ? "annual" : "personal"] += Number(row.values.output_minutes);
    allocations.set(sourceRow, current);
  }
  return { allocations, stages: result.stages };
}

export async function processAnnualSettlement(leavePath: string, balancePath: string, allowStaleOrOptions: boolean | AnnualSettlementOptions): Promise<ProcessResult> {
  const options: AnnualSettlementOptions = typeof allowStaleOrOptions === "boolean" ? { allowStaleBalance: allowStaleOrOptions } : allowStaleOrOptions;
  const rule = SettlementRuleSchema.parse(options.settlement ?? {}), filters = options.filters ?? [];
  const source = await readLeaves(leavePath, rule.minutesPerDay, options.patches, options.aliasesByPath?.[leavePath]), balanceBook = await readWorkbook(balancePath);
  const balanceTab = patchedTab(readTabularSheet(balanceBook), balancePath, options.patches ?? []);
  const balanceMap = matchFields(balanceTab.headers, options.aliasesByPath?.[balancePath]); requireFields(balanceMap, ["employeeId", "name", "department", "annualBalance"]);
  const rawFirst = XLSXFirstCell(balanceBook, balanceTab.name), balanceAsOf = detectBalanceAsOf(balanceTab.name, rawFirst);
  const filtered = filterRowsV3({ id: "annual-settlement", rows: source.rows.map((row) => ({ sourceRow: row.sourceRow, sourceFile: basename(leavePath), sourceSheet: source.tabName, values: { employeeId: row.employeeId, name: row.name, department: row.department, leaveType: row.leaveType, startDate: row.start.slice(0, 10), minutes: row.minutes, documentNo: row.documentNo } })), columns: { employeeId: "text", name: "text", department: "text", leaveType: "text", startDate: "date", minutes: "integer", documentNo: "text" }, filters });
  const selected = source.rows.filter((row) => filtered.sourceRows.has(row.sourceRow));
  const selectedForSettlement = selected.filter((row) => rule.enabledForLeaveTypes.includes(row.leaveType));
  const latestLeaveMonth = selectedForSettlement.map((r) => r.start.slice(0, 7)).sort().at(-1) ?? balanceAsOf;
  if (balanceAsOf < latestLeaveMonth && !options.allowStaleBalance) throw new Error(`年假余额时点 ${balanceAsOf} 早于参与结算的请假月份 ${latestLeaveMonth}，必须确认使用旧余额`);

  const byId = new Map<string, Array<{ employeeId: string; name: string; department: string; openingMinutes: number }>>();
  const exceptions = [...source.exceptions];
  balanceTab.rows.forEach((row, i) => {
    const raw = rawObject(balanceTab.headers, row), sourceRow = balanceTab.sourceRows[i];
    try {
      const id = employeeId(value(row, balanceMap, "employeeId"));
      const item = { employeeId: id, name: String(value(row, balanceMap, "name") ?? "").trim(), department: String(value(row, balanceMap, "department") ?? "").trim(), openingMinutes: decimalMultiplyToInteger(value(row, balanceMap, "annualBalance"), rule.minutesPerDay) };
      if (item.openingMinutes < 0) throw new Error("年假余额不能为负数");
      const list = byId.get(id) ?? []; list.push(item); byId.set(id, list);
    } catch (error) { exceptions.push(exception("BALANCE_INVALID", "error", (error as Error).message, balancePath, balanceTab.name, sourceRow, raw)); }
  });

  const remaining = new Map<string, number>(), opening = new Map<string, number>(), deducted = new Map<string, number>();
  for (const [id, list] of byId) if (list.length === 1) { remaining.set(id, list[0].openingMinutes); opening.set(id, list[0].openingMinutes); deducted.set(id, 0); }
  const eligible = [...selected].sort((a, b) => compareLocalDateTime(a.start, b.start) || a.documentNo.localeCompare(b.documentNo) || a.sourceRow - b.sourceRow);
  const allocations = new Map<number, { annual: number; personal: number }>(), v3Items: Array<{ leave: LeaveRow; openingMinutes: number }> = [];
  for (const leave of eligible) {
    if (!rule.enabledForLeaveTypes.includes(leave.leaveType)) { allocations.set(leave.sourceRow, { annual: 0, personal: leave.minutes }); continue; }
    const balances = byId.get(leave.employeeId);
    if (!balances?.length) { exceptions.push(exception("BALANCE_MISSING", "error", "未找到年假余额", leavePath, source.tabName, leave.sourceRow, leave.raw, leave.employeeId)); continue; }
    if (balances.length > 1) { exceptions.push(exception("BALANCE_DUPLICATE", "error", "年假余额存在重复工号", leavePath, source.tabName, leave.sourceRow, leave.raw, leave.employeeId)); continue; }
    const balance = balances[0];
    if (balance.name !== leave.name || balance.department !== leave.department) { exceptions.push(exception("BALANCE_IDENTITY_CONFLICT", "error", "年假表与请假单姓名或部门不一致", leavePath, source.tabName, leave.sourceRow, leave.raw, leave.employeeId)); continue; }
    v3Items.push({ leave, openingMinutes: balance.openingMinutes });
  }
  const v3 = allocateSettlementV3(v3Items);
  for (const { leave } of v3Items) {
    const allocation = v3.allocations.get(leave.sourceRow);
    if (!allocation) continue;
    allocations.set(leave.sourceRow, allocation);
    deducted.set(leave.employeeId, (deducted.get(leave.employeeId) ?? 0) + allocation.annual);
  }
  for (const [id, start] of opening) remaining.set(id, start - (deducted.get(id) ?? 0));
  const rows: OutputRow[] = [];
  for (const leave of selected) {
    const a = allocations.get(leave.sourceRow); if (!a) continue;
    if (!rule.enabledForLeaveTypes.includes(leave.leaveType)) rows.push(leaveOutput(leave, leave.leaveType));
    else { if (a.annual > 0) rows.push(leaveOutput(leave, rule.annualLeaveType, a.annual)); if (a.personal > 0 || leave.minutes === 0) rows.push(leaveOutput(leave, rule.fallbackLeaveType, a.personal)); }
  }
  const balanceAudit: BalanceAuditRow[] = [];
  for (const [id, start] of opening) {
    const b = byId.get(id)![0]; balanceAudit.push({ employeeId: id, name: b.name, department: b.department, openingMinutes: start, deductedMinutes: deducted.get(id) ?? 0, closingMinutes: remaining.get(id) ?? start, balanceAsOf });
  }
  balanceAudit.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  const annualMinutes = rows.filter((r) => r.cells[3] === rule.annualLeaveType).reduce((s, r) => s + (r.minutes ?? 0), 0), personalMinutes = rows.filter((r) => r.cells[3] === rule.fallbackLeaveType).reduce((s, r) => s + (r.minutes ?? 0), 0);
  const isolatedSelected = selected.filter((r) => !allocations.has(r.sourceRow));
  return { sheetName: "导入HR 格式", headers: LEAVE_HEADERS, rows, exceptions, balanceAudit, sourceCount: source.sourceCount, stages: [...filtered.stages, ...v3.stages], summary: { inputRecords: source.sourceCount, inputRows: source.sourceCount, validRecords: source.rows.length, validRows: source.rows.length, filteredOutRows: source.rows.length - selected.length, filteredRows: source.rows.length - selected.length, calculationRows: allocations.size, outputRecords: rows.length, outputRows: rows.length, matchedSourceRows: allocations.size, isolatedRows: isolatedSelected.length + source.exceptions.length, annualMinutes, personalMinutes, isolatedMinutes: isolatedSelected.reduce((s, r) => s + r.minutes, 0), balanceAsOfNumeric: Number(balanceAsOf.replace("-", "")), minutesPerDay: rule.minutesPerDay } };
}

function XLSXFirstCell(workbook: Awaited<ReturnType<typeof readWorkbook>>, sheet: string): string {
  const target = workbook.Sheets[sheet] as unknown as { A1?: { v?: unknown }; "!data"?: Array<Array<{ v?: unknown } | undefined>> };
  const cell = target.A1 ?? target["!data"]?.[0]?.[0];
  return String(cell?.v ?? "");
}

export async function executePlan(plan: ProcessPlan, patches: SourcePatch[] = [], aliasesByPath: Record<string, Record<string, string[]>> = {}): Promise<ProcessResult> {
  if (plan.operation === "erp_overtime_to_hr") { const path = plan.sources.overtime ?? Object.values(plan.sources)[0]; return processOvertime(path, plan.filters, patches, aliasesByPath[path]); }
  if (plan.operation === "oa_leave_to_hr") { const path = plan.sources.leave ?? Object.values(plan.sources)[0]; return processLeave(path, plan.filters, patches, aliasesByPath[path]); }
  return processAnnualSettlement(plan.sources.leave, plan.sources.balance, { allowStaleBalance: plan.allowStaleBalance, filters: plan.filters, settlement: plan.settlement, patches, aliasesByPath });
}
