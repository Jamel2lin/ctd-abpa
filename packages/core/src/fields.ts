import { createHash } from "node:crypto";

export const FIELD_ALIASES: Record<string, string[]> = {
  employeeId: ["工号", "员工编号", "人员编号", "职工号"],
  name: ["姓名", "申请人", "员工姓名"],
  department: ["部门", "班组名称", "所属部门"],
  position: ["职位", "岗位", "职位名称"],
  startDate: ["起始日期", "开始日期"],
  startTime: ["起始时间", "开始时间"],
  endDate: ["结束日期", "终止日期"],
  endTime: ["结束时间", "终止时间"],
  overtimeHours: ["申请加班", "加班小时", "加班工时"],
  leaveType: ["请假类型", "结算结果", "缺勤类别"],
  hours: ["小时", "合计小时"],
  days: ["天", "请假天数"],
  documentNo: ["单据编号", "单号"],
  annualBalance: ["剩余年假", "年假余额", "可用年假"],
};

export function mappingScope(fileName: string, sheetFingerprint: string): string { return `${fileName}\u001f${sheetFingerprint}`; }
export function sourceIdentityScope(system: string, reportType: string): string {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "-");
  const scope = `${normalize(system)}:${normalize(reportType)}`;
  if (!system.trim() || !reportType.trim()) throw new Error("来源系统与报表类型不能为空");
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope) ? scope : `source-${createHash("sha256").update(`${system.trim()}\u0000${reportType.trim()}`).digest("hex").slice(0, 24)}`;
}

export function canonicalField(field: string): string {
  if (field in FIELD_ALIASES) return field;
  for (const [standard, aliases] of Object.entries(FIELD_ALIASES)) if (aliases.includes(field)) return standard;
  return field;
}

export function matchFields(headers: string[], userAliases: Record<string, string[]> = {}): Record<string, number> {
  const result: Record<string, number> = {};
  const normalized = headers.map((h) => h.trim());
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const candidates = [field, ...aliases, ...(userAliases[field] ?? [])];
    const indexes = normalized.map((h, i) => candidates.includes(h) ? i : -1).filter((i) => i >= 0);
    if (indexes.length > 1) throw new Error(`字段 ${field} 存在多个候选列: ${indexes.map((i) => headers[i]).join(", ")}`);
    if (indexes.length === 1) result[field] = indexes[0];
  }
  return result;
}

export function requireFields(mapping: Record<string, number>, fields: string[]): void {
  const missing = fields.filter((f) => mapping[f] === undefined);
  if (missing.length) throw new Error(`缺少必要字段: ${missing.join(", ")}`);
}
