import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAnnualSettlement, writeDeliverables, writeXlsxWorkbook } from "@ctd-abpa/excel";
import { invalidateConfirmation } from "@ctd-abpa/core";
import type { ProcessPlan } from "@ctd-abpa/types";

const data = resolve("data/自动化桥接与处理智能体数据集file");

describe("年假旧余额显式确认与时点判定机制", () => {
  it("仅有月份且请假发生在同月时，无法证明余额截至日，必须显式确认", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ctd-month-only-"));
    const balance = join(tempDir, "balance.csv"), leave = join(tempDir, "leave.csv");
    try {
      await writeFile(balance, "2026年4月年假余额\n工号,姓名,部门,剩余年假\n001,林一,A,10\n");
      await writeFile(leave, "工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号\n001,林一,A,事假,2026-04-02,08:00,2026-04-02,17:00,0,1,D001\n");
      await expect(processAnnualSettlement(leave, balance, false)).rejects.toThrow(/仅标注 2026-04，无法证明其截至日不早于.*必须显式确认/);
      expect(await processAnnualSettlement(leave, balance, true)).toMatchObject({ balanceAsOf: "2026-04", latestLeaveDate: "2026-04-02", isStaleBalance: true });
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  it("余额表有具体日期时按日比较，同日及之后不要求旧余额确认", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ctd-exact-date-"));
    const balance = join(tempDir, "balance.csv"), leave = join(tempDir, "leave.csv");
    try {
      await writeFile(leave, "工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号\n001,林一,A,事假,2026-04-02,08:00,2026-04-02,17:00,0,1,D001\n");
      const writeBalance = (date: string) => writeFile(balance, `${date}年假余额\n工号,姓名,部门,剩余年假\n001,林一,A,10\n`);
      await writeBalance("2026年4月1日");
      await expect(processAnnualSettlement(leave, balance, false)).rejects.toThrow(/2026-04-01 早于参与结算的请假日期 2026-04-02/);
      await writeBalance("2026年4月2日");
      expect(await processAnnualSettlement(leave, balance, false)).toMatchObject({ balanceAsOf: "2026-04-02", isStaleBalance: false });
      await writeBalance("2026-04-03");
      expect(await processAnnualSettlement(leave, balance, false)).toMatchObject({ balanceAsOf: "2026-04-03", isStaleBalance: false });
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  it("场景 1：余额时点早于请假日期（过期）且未显式确认时，直接拒绝执行并提示准确时点", async () => {
    // 年假.xls 为 2026-02，OA导出请假单.xlsx 请假为 2026-04
    await expect(
      processAnnualSettlement(
        resolve(data, "OA导出请假单.xlsx"),
        resolve(data, "年假.xls"),
        false
      )
    ).rejects.toThrow(/年假余额时点 2026-02 早于参与结算的请假日期 2026-04-30，必须确认使用旧余额/);
  });

  it("场景 2：余额时点早于请假日期，但 HR 显式确认继续使用时，顺利执行并标记 isStaleBalance", async () => {
    const result = await processAnnualSettlement(
      resolve(data, "OA导出请假单.xlsx"),
      resolve(data, "年假.xls"),
      true
    );
    expect(result.isStaleBalance).toBe(true);
    expect(result.balanceAsOf).toBe("2026-02");
    expect(result.latestLeaveDate).toBe("2026-04-30");
    expect(result.summary.isStaleBalance).toBe(1);
    expect(result.summary.balanceAsOfNumeric).toBe(202602);
    expect(result.rows.length).toBeGreaterThan(0);

    // 验证审计清单正确固化了确认依据与时点
    const tempDir = await mkdtemp(join(tmpdir(), "ctd-stale-test-"));
    try {
      const plan: ProcessPlan = {
        version: 1,
        operation: "annual_leave_settlement",
        sources: { leave: resolve(data, "OA导出请假单.xlsx"), balance: resolve(data, "年假.xls") },
        filters: [],
        allowStaleBalance: true,
        confirmedBy: "HR-张主管",
      };
      const manifest = await writeDeliverables({
        taskId: "test-stale-audit",
        outputDir: tempDir,
        result,
        plan,
        confirmedBy: "HR-张主管",
      });
      expect(manifest.confirmations).toHaveLength(1);
      expect(manifest.confirmations[0]).toMatchObject({
        type: "stale_balance",
        confirmedBy: "HR-张主管",
        details: {
          balanceAsOf: 202602,
          balanceAsOfText: "2026-02",
          latestLeaveDate: "2026-04-30",
        },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("场景 3：余额日期 >= 请假日期（未过期）时，正常自动处理，无需 allowStaleBalance", async () => {
    // 创建一个时点为 2026年5月（晚于请假 2026-04）的测试余额表
    const tempDir = await mkdtemp(join(tmpdir(), "ctd-fresh-balance-"));
    const freshBalancePath = join(tempDir, "2026年5月年假.xlsx");
    try {
      await writeXlsxWorkbook(
        [{
          name: "5月",
          rows: [
            ["2026年休假明细 5月", "", "", "", "", "", "", "", ""],
            ["工号", "姓名", "部门", "职位名称", "聘用日期", "合计享有年假", "5月已享年假天数", "剩余年假", "备注"],
            ["E11004", "咸希", "精工二车间", "操作工", "3/15/20", "10", "0", "10", ""],
          ],
          widths: [12, 12, 12, 12, 12, 12, 12, 12, 12],
        }],
        freshBalancePath
      );

      // allowStaleBalance 为 false
      const result = await processAnnualSettlement(
        resolve(data, "OA导出请假单.xlsx"),
        freshBalancePath,
        false
      );

      // 验证正常自动处理：不需要旧余额确认，isStaleBalance 为 false
      expect(result.isStaleBalance).toBe(false);
      expect(result.balanceAsOf).toBe("2026-05");
      expect(result.summary.isStaleBalance).toBe(0);
      expect(result.rows.length).toBeGreaterThan(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("场景 4：修改计划或重新分析后失效确认，并彻底清除 staleBalanceCheck 强制重新预演", () => {
    const task: any = {
      id: "task-stale",
      status: "awaiting_confirmation",
      createdAt: "",
      updatedAt: "",
      files: [],
      plan: { version: 1, operation: "annual_leave_settlement", sources: {}, filters: [], allowStaleBalance: false },
      planRevision: 1,
      previewHash: "preview-hash",
      staleBalanceCheck: { isStale: true, balanceAsOf: "2026-02", latestLeaveDate: "2026-04-30" },
      confirmation: { planRevision: 1, bindingHash: "bind", confirmedBy: "HR", confirmedAt: "" },
    };
    invalidateConfirmation(task);
    expect(task.confirmation).toBeUndefined();
    expect(task.previewHash).toBeUndefined();
    expect(task.staleBalanceCheck).toBeUndefined();
    expect(task.planRevision).toBe(2);
  });
});
