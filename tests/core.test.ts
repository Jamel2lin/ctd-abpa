import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateAnnualLeave, combineLocalDateTime, decimalHoursToMinutes, matchFields, parseLocalDate, safeSpreadsheetText } from "@ctd-abpa/core";

describe("确定性核心", () => {
  it("匹配内置中文别名", () => expect(matchFields(["员工编号", "申请人", "所属部门", "岗位"])).toEqual({ employeeId: 0, name: 1, department: 2, position: 3 }));
  it("拒绝同一字段的多个候选", () => expect(() => matchFields(["工号", "员工编号"])).toThrow(/多个候选/));
  it("保留前导零并阻止公式注入", () => { expect(String("00127")).toBe("00127"); expect(safeSpreadsheetText("=1+1")).toBe("'=1+1"); });
  it("严格解析本地日期时间", () => { expect(parseLocalDate("4/1/26").iso).toBe("2026-04-01"); expect(combineLocalDateTime("2026-04-01", "8:05")).toBe("2026-04-01 08:05"); expect(() => parseLocalDate("2026-02-30")).toThrow(); });
  it("解析 Excel 1900 日期序列并拒绝虚构闰日", () => { expect(parseLocalDate(61).iso).toBe("1900-03-01"); expect(parseLocalDate(46_114).iso).toBe("2026-04-02"); expect(() => parseLocalDate(60)).toThrow(/Excel/); });
  it("十进制定点工时精确换算", () => { expect(decimalHoursToMinutes("2.5")).toBe(150); expect(decimalHoursToMinutes("0.25")).toBe(15); expect(() => decimalHoursToMinutes("0.333")).toThrow(/整数分钟/); });

  it("属性：请假分钟等于年假与事假之和，余额守恒", () => fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), (request, balance) => {
    const result = allocateAnnualLeave(request, balance);
    expect(result.annualMinutes + result.personalMinutes).toBe(request);
    expect(result.annualMinutes + result.remainingMinutes).toBe(balance);
    expect(result.annualMinutes).toBeLessThanOrEqual(Math.min(request, balance));
  })));
});
