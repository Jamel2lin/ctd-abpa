import { resolve } from "node:path";
import { executePlan, writeDeliverables } from "@ctd-abpa/excel";
import { validatePlan } from "@ctd-abpa/core";

const data = resolve("data/自动化桥接与处理智能体数据集file"), root = resolve("outputs/demo");
const jobs = [
  { id: "erp-overtime", output: "加班转HR", plan: { version: 1, operation: "erp_overtime_to_hr", sources: { overtime: resolve(data, "ERP导出加班.XLSX") }, filters: [], allowStaleBalance: false } },
  { id: "oa-leave", output: "请假转HR", plan: { version: 1, operation: "oa_leave_to_hr", sources: { leave: resolve(data, "OA导出请假单.xlsx") }, filters: [], allowStaleBalance: false } },
  { id: "annual-settlement", output: "年假结算", plan: { version: 1, operation: "annual_leave_settlement", sources: { leave: resolve(data, "OA导出请假单.xlsx"), balance: resolve(data, "年假.xls") }, filters: [], settlement: {}, allowStaleBalance: true, confirmedBy: "Jamel" } },
] as const;

for (const job of jobs) {
  const plan = validatePlan(job.plan), result = await executePlan(plan);
  const manifest = await writeDeliverables({ taskId: job.id, outputDir: resolve(root, job.output), result, plan, confirmedBy: "Jamel" });
  console.log(`${job.output}: ${manifest.status}`, manifest.reconciliation, manifest.calculationSummary);
}
