import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processAnnualSettlement, readWorkbook } from "@ctd-abpa/excel";

describe("配置驱动年假结算", () => {
  it("先筛选再以自定义每日分钟和假别名称结算，并分别对账", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-settlement-"));
    const leave = join(directory, "leave.csv"), balance = join(directory, "balance.csv");
    try {
      await writeFile(leave, [
        "工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号",
        "001,林一,A,事假,2026-04-01,08:00,2026-04-01,17:00,0,1,D002",
        "001,林一,A,事假,2026-04-02,08:00,2026-04-02,17:00,0,1,D003",
        "002,林二,B,事假,2026-05-01,08:00,2026-05-01,17:00,0,1,D004",
      ].join("\n"));
      await writeFile(balance, [
        "2026年4月3日年假余额",
        "工号,姓名,部门,剩余年假",
        "001,林一,A,1.5",
      ].join("\n"));
      const result = await processAnnualSettlement(leave, balance, {
        allowStaleBalance: false,
        filters: [{ field: "department", operator: "eq", value: "A" }],
        settlement: { minutesPerDay: 420, enabledForLeaveTypes: ["事假"], annualLeaveType: "调休", fallbackLeaveType: "无薪假" },
      });
      expect(result.rows.map((row) => [row.documentNo, row.cells[3], row.minutes])).toEqual([
        ["D002", "调休", 420], ["D003", "调休", 210], ["D003", "无薪假", 210],
      ]);
      expect(result.summary).toMatchObject({ inputRecords: 3, filteredOutRows: 1, calculationRows: 2, outputRows: 3, annualMinutes: 630, personalMinutes: 210 });
      expect(result.stages?.find((stage) => stage.stepId === "allocate")?.metrics).toEqual({ allocatedMinutes: 630, fallbackMinutes: 210 });
      expect(result.stages?.find((stage) => stage.stepId === "split")?.metrics).toEqual({ "branch.annual.rows": 2, "branch.personal.rows": 1, "branch.zero.rows": 0 });
      expect(result.balanceAudit.find((row) => row.employeeId === "001")).toMatchObject({ openingMinutes: 630, deductedMinutes: 630, closingMinutes: 0 });
      const sheet = (await readWorkbook(leave)).SheetNames[0];
      const corrected = await processAnnualSettlement(leave, balance, {
        allowStaleBalance: false,
        filters: [{ field: "department", operator: "eq", value: "A" }],
        settlement: { minutesPerDay: 420, enabledForLeaveTypes: ["事假"], annualLeaveType: "调休", fallbackLeaveType: "无薪假" },
        patches: [{ sourcePath: leave, sourceSheet: sheet, sourceRow: 2, sourceIndex: 9, action: "correct", value: "0.5" }],
      });
      expect(corrected.rows.map((row) => [row.documentNo, row.cells[3], row.minutes])).toEqual([["D002", "调休", 210], ["D003", "调休", 420]]);
      expect(corrected.balanceAudit.find((row) => row.employeeId === "001")).toMatchObject({ openingMinutes: 630, deductedMinutes: 630, closingMinutes: 0 });
    } finally { await rm(directory, { recursive: true }); }
  });

  it("隔离倒置时间、缺失必填和重复单据，正常行继续", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-settlement-errors-"));
    const leave = join(directory, "leave.csv"), balance = join(directory, "balance.csv");
    try {
      await writeFile(leave, [
        "工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号",
        "001,林一,A,事假,2026-04-01,08:00,2026-04-01,17:00,0,1,OK",
        "001,林一,A,事假,2026-04-03,17:00,2026-04-03,08:00,1,0,BACK",
        "001,,A,事假,2026-04-04,08:00,2026-04-04,17:00,1,0,MISSING",
        "001,林一,A,事假,2026-04-05,08:00,2026-04-05,17:00,1,0,DUP",
        "001,林一,A,事假,2026-04-06,08:00,2026-04-06,17:00,1,0,DUP",
      ].join("\n"));
      await writeFile(balance, "2026年4月2日年假余额\n工号,姓名,部门,剩余年假\n001,林一,A,10\n");
      const result = await processAnnualSettlement(leave, balance, false);
      expect(result.rows).toHaveLength(1); expect(result.rows[0].documentNo).toBe("OK");
      expect(result.exceptions.filter((error) => error.code === "ROW_INVALID")).toHaveLength(2);
      expect(result.exceptions.filter((error) => error.code === "LEAVE_DOCUMENT_DUPLICATE")).toHaveLength(2);
      expect(result.summary).toMatchObject({ inputRecords: 5, calculationRows: 1, isolatedRows: 4, outputRecords: 1 });
    } finally { await rm(directory, { recursive: true }); }
  });
});
