import { AnyProcessPlanSchema, ProcessPlanSchema, ProcessPlanV2Schema, type AnyProcessPlan, type ProcessPlan, type ProcessPlanV2 } from "@ctd-abpa/types";

export function detectOperation(text: string): ProcessPlan["operation"] {
  if (/年假.*(抵扣|结算)|抵扣.*年假/.test(text)) return "annual_leave_settlement";
  if (/请假|缺勤/.test(text)) return "oa_leave_to_hr";
  if (/加班/.test(text)) return "erp_overtime_to_hr";
  throw new Error("无法识别任务类型，请明确说明加班转换、请假转换或年假抵扣");
}

export function parseInstruction(instruction: string, sources: Record<string, string>): ProcessPlan {
  const text = instruction.trim();
  const unsupported = ["审批", "批准", "姓名", "工号", "员工", "人员", "只保留", "仅保留", "筛选", "过滤"].filter((term) => text.includes(term));
  if (unsupported.length) throw new Error(`指令包含尚未转换为规则的条件：${unsupported.join("、")}。请在计划中明确设置筛选条件后预览`);
  const operation = detectOperation(text);

  const filters: ProcessPlan["filters"] = [];
  const department = /(?:部门|车间)[为：:\s]*([^，,；;]+?)(?:，|,|；|;|$)/.exec(text)?.[1]?.trim();
  if (department) filters.push({ field: "department", operator: "eq", value: department });
  const dateRange = /(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s*(?:至|到|~|—|-)\s*(20\d{2}[-/]\d{1,2}[-/]\d{1,2})/.exec(text);
  if (dateRange) filters.push({ field: "startDate", operator: "between", value: [dateRange[1], dateRange[2]] });
  return ProcessPlanSchema.parse({ version: 1, operation, sources, filters, settlement: operation === "annual_leave_settlement" ? {} : undefined });
}

export function validatePlan(input: unknown): ProcessPlan { return ProcessPlanSchema.parse(input); }
export function validatePlanV2(input: unknown): ProcessPlanV2 { return ProcessPlanV2Schema.parse(input); }
export function validateAnyPlan(input: unknown): AnyProcessPlan { return AnyProcessPlanSchema.parse(input); }
