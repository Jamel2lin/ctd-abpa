import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeWorkbook, assertBiff8RowLimit, readWorkbook, readTabularSheet, writeHrXls } from "@ctd-abpa/excel";

describe("Excel 兼容", () => {
  it("强制 BIFF8 行上限", () => { expect(() => assertBiff8RowLimit(65_535)).not.toThrow(); expect(() => assertBiff8RowLimit(65_536)).toThrow(/65,535/); });
  it("写出 CDFV2、文本单元格、中文表名和前导零", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctd-abpa-")), path = join(dir, "out.xls");
    try {
      await writeHrXls({ sheetName: "导入HR 格式", headers: ["工号"], rows: [{ sourceRow: 2, cells: ["00123"] }], exceptions: [], balanceAudit: [], sourceCount: 1, summary: {} }, path);
      expect([...await readFile(path)].slice(0, 8)).toEqual([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
      const tab = readTabularSheet(await readWorkbook(path), "导入HR 格式"); expect(tab.rows[0][0]).toBe("00123");
    } finally { await rm(dir, { recursive: true }); }
  });
  it("生成稳定文件/Sheet/列 ID，并保留重复表头位置", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctd-analysis-")), path = join(dir, "duplicate.csv");
    try {
      await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "工号,工号,备注\n001,002,ok\n"));
      const first = await analyzeWorkbook(path), second = await analyzeWorkbook(path);
      expect(first.id).toBe(second.id); expect(first.sheets[0].id).toBe(second.sheets[0].id);
      expect(first.sheets[0].duplicateHeaders).toEqual(["工号"]);
      expect(new Set(first.sheets[0].columns.map((column) => column.id)).size).toBe(3);
      expect(first.kind).toBe("unknown");
    } finally { await rm(dir, { recursive: true }); }
  });
  it("允许显式选择并合并多行表头", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctd-headers-")), path = join(dir, "multi.csv");
    try {
      await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "员工,工时\n工号,小时\n001,2\n"));
      const tab = readTabularSheet(await readWorkbook(path), { headerRows: [1, 2] });
      expect(tab.headers).toEqual(["员工/工号", "工时/小时"]); expect(tab.sourceRows).toEqual([3]); expect(tab.rows[0][0]).toBe("001");
    } finally { await rm(dir, { recursive: true }); }
  });
});
