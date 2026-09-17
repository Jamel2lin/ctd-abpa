import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { batchTemplatedOutputs, prepareTemplatedData, prepareTemplatedOutputs, readWorkbook, writeTemplatedWorkbook, writeTemplatedWorkbookV3 } from "@ctd-abpa/excel";

describe("模板驱动写出与复读", () => {
  it("两张工作表分别校验和写出各自绑定的数据", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-multisheet-")), path = join(directory, "result.xlsx");
    try {
      const template = { id: "multi", version: 1, format: "xlsx" as const, sheets: [
        { sheetId: "detail", name: "明细", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" as const }] },
        { sheetId: "total", name: "汇总", headerRow: 2, columns: [{ columnId: "amount", header: "金额", dataType: "decimal" as const }] },
      ] };
      const outputs = {
        detail: { columns: { id: "text" as const }, rows: [{ values: { id: "001" }, lineage: [] }] },
        total: { columns: { amount: "decimal" as const }, rows: [{ values: { amount: "1.3" }, lineage: [] }] },
      };
      expect(prepareTemplatedOutputs({ outputs, template }).outputRows).toBe(2);
      expect((await writeTemplatedWorkbookV3({ outputs, template, path })).outputRows).toBe(2);
      const workbook = await readWorkbook(path);
      expect(workbook.SheetNames).toEqual(["明细", "汇总"]);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("预览与导出共用严格布尔和必填校验", () => {
    const data = { columns: { id: "text" as const, approved: "text" as const }, rows: [
      { values: { id: "001", approved: "false" }, lineage: [{ sourceFile: "a.csv", sourceSheet: "Sheet1", sourceRow: 2 }] },
      { values: { id: "", approved: "true" }, lineage: [{ sourceFile: "a.csv", sourceSheet: "Sheet1", sourceRow: 3 }] },
    ] };
    const template = { id: "bool", version: 1, format: "xlsx" as const, sheets: [{ sheetId: "out", name: "输出", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" as const, required: true }, { columnId: "approved", header: "审批", dataType: "boolean" as const }] }] };
    const prepared = prepareTemplatedData({ data, template });
    expect(prepared.data.rows).toHaveLength(1);
    expect(prepared.exceptions).toHaveLength(1);
    expect(prepared.data.rows[0].values.approved).toBe("false");
  });
  it("超过容量时按行序分批，每批复读保持类型和数量", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-batches-"));
    try {
      const template = { id: "batch", version: 1, format: "xlsx" as const, sheets: [{ sheetId: "out", name: "结果", headerRow: 2, maxDataRows: 2, columns: [{ columnId: "id", header: "ID", dataType: "text" as const }, { columnId: "value", header: "数量", dataType: "integer" as const }] }] };
      const outputs = { out: { columns: { id: "text" as const, value: "integer" as const }, rows: ["001", "002", "003"].map((id, index) => ({ values: { id, value: index + 1 }, lineage: [] })) } };
      const prepared = batchTemplatedOutputs({ outputs, template });
      expect(prepared.batches.map((batch) => batch.out.rows.length)).toEqual([2, 1]);
      for (let index = 0; index < prepared.batches.length; index++) {
        const path = join(directory, `part-${index + 1}.xlsx`);
        expect((await writeTemplatedWorkbookV3({ outputs: prepared.batches[index], template, path })).outputRows).toBe(index === 0 ? 2 : 1);
        const sheet = (await readWorkbook(path)).Sheets["结果"] as unknown as { "!data": Array<Array<{ t?: string; v?: unknown } | undefined>> };
        expect(sheet["!data"][2][0]?.v).toBe(index === 0 ? "001" : "003");
        expect(sheet["!data"][2][1]?.t).toBe("n");
      }
    } finally { await rm(directory, { recursive: true }); }
  });
  it("按模板位置、顺序和类型输出，并逐行隔离必填错误", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-template-")), path = join(directory, "result.xlsx");
    try {
      const result = await writeTemplatedWorkbook({
        path,
        data: {
          columns: { employee_id: "text", amount: "decimal", date: "date", note: "text" },
          rows: [
            { values: { employee_id: "00123", amount: "12.5", date: "2026-09-12", note: null }, lineage: [{ sourceFile: "source.csv", sourceSheet: "Sheet1", sourceRow: 2 }] },
            { values: { employee_id: "", amount: "3", date: "2026-09-13", note: "x" }, lineage: [{ sourceFile: "source.csv", sourceSheet: "Sheet1", sourceRow: 3 }] },
          ],
        },
        template: { id: "typed", version: 1, format: "xlsx", sheets: [{ sheetId: "output", name: "目标", headerRow: 2, columns: [
          { columnId: "employee_id", header: "工号", dataType: "text", required: true },
          { columnId: "date", header: "日期", dataType: "date", required: true, numberFormat: "yyyy-mm-dd" },
          { columnId: "amount", header: "金额", dataType: "decimal", required: true, numberFormat: "0.00" },
          { columnId: "note", header: "备注", dataType: "text", required: false, defaultValue: "无" },
        ] }] },
      });
      expect(result.outputRows).toBe(1); expect(result.exceptions).toHaveLength(1);
      const workbook = await readWorkbook(path), sheet = workbook.Sheets["目标"] as unknown as { "!data": Array<Array<{ t?: string; v?: unknown; z?: string } | undefined>> }, cells = sheet["!data"];
      expect(cells[1][0]?.v).toBe("工号"); expect(cells[2][0]?.v).toBe("00123"); expect(cells[2][0]?.t).toBe("s");
      expect(cells[2][1]?.t).toBe("n"); expect(cells[2][1]?.z).toBe("yyyy-mm-dd"); expect(cells[2][2]?.v).toBe(12.5); expect(cells[2][2]?.t).toBe("n"); expect(cells[2][3]?.v).toBe("无");
    } finally { await rm(directory, { recursive: true }); }
  });
});
