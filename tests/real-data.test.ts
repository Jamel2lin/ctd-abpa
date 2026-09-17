import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { processAnnualSettlement, processLeave, processOvertime, readWorkbook, readTabularSheet } from "@ctd-abpa/excel";

const data = resolve("data/自动化桥接与处理智能体数据集file");

describe("真实数据黄金验收", () => {
  it("ERP 加班", async () => {
    const r = await processOvertime(resolve(data, "ERP导出加班.XLSX"));
    expect(r.sourceCount).toBe(36_001); expect(r.rows).toHaveLength(35_970);
    const negative = r.exceptions.filter((e) => e.code === "OT_NEGATIVE_HOURS");
    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatchObject({ businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "ERP" });
    const identity = r.exceptions.filter((e) => e.code === "IDENTITY_NAME_CONFLICT" && e.employeeId === "E10427");
    expect(identity).toHaveLength(30);
    expect(identity.every((e) => e.businessLevel === "L3" && e.disposition === "alert_and_isolate" && e.requiresHumanReview && !e.automationAllowed && e.sourceOfTruth === "HR Master Data")).toBe(true);
    expect(r.exceptions.filter((e) => e.code === "OT_ZERO_HOURS")).toHaveLength(522);
    expect(r.stages?.map((stage) => stage.operator)).toEqual(["select"]);
  }, 20_000);
  it("OA 请假", async () => {
    const r = await processLeave(resolve(data, "OA导出请假单.xlsx"));
    expect(r.sourceCount).toBe(13); expect(r.rows).toHaveLength(13); expect(r.summary.totalMinutes).toBe(190 * 60);
    expect(r.stages?.map((stage) => stage.operator)).toEqual(["select"]);
  });
  it("OA 请假输出与业务方提供的 HR 候选样例逐单元格一致", async () => {
    const actual = await processLeave(resolve(data, "OA导出请假单.xlsx"));
    const expected = readTabularSheet(await readWorkbook(resolve(data, "HR 系统需要最低版本导入.xls")), "导入HR 格式");
    expect(actual.headers).toEqual(expected.headers);
    expect(actual.rows.map((row) => row.cells)).toEqual(expected.rows.map((row) => row.map((cell) => String(cell ?? ""))));
  });
  it("年假结算", async () => {
    const r = await processAnnualSettlement(resolve(data, "OA导出请假单.xlsx"), resolve(data, "年假.xls"), true);
    expect(r.summary.matchedSourceRows).toBe(7); expect(r.summary.isolatedRows).toBe(6);
    expect(r.summary.annualMinutes).toBe(46 * 60); expect(r.summary.personalMinutes).toBe(42 * 60); expect(r.summary.isolatedMinutes).toBe(102 * 60);
    expect(r.stages?.map((stage) => stage.operator)).toEqual(["select", "allocate_balance", "split_rows"]);
  });
  it("旧余额未确认时拒绝执行", async () => expect(processAnnualSettlement(resolve(data, "OA导出请假单.xlsx"), resolve(data, "年假.xls"), false)).rejects.toThrow(/必须确认/));
});
