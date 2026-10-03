import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeWorkbook, executeWorkbookPlanV2, readTabularSheet, readWorkbook } from "@ctd-abpa/excel";
import { ProcessPlanV3Schema, type TaskRecord } from "@ctd-abpa/types";

it("显式表头可位于20行之后，合并表头与稳定列 ID 一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctd-header-")), path = join(root, "deep.csv");
  try {
    await writeFile(path, `${"前言\n".repeat(30)}SKU,数量\n编码,件\nA,2\n`);
    const initial = await analyzeWorkbook(path, "deep");
    const sheetId = initial.sheets[0].id;
    const analyzed = await analyzeWorkbook(path, "deep", { [sheetId]: [31, 32] });
    expect(analyzed.sheets[0]).toMatchObject({ headerRow: 32, headers: ["SKU/编码", "数量/件"], rowCount: 1 });
    expect(analyzed.sheets[0].columns[1].id).toBe(initial.sheets[0].columns[1].id);
    const tab = readTabularSheet(await readWorkbook(path), { headerRows: [31, 32] }); expect(tab.sourceRows).toEqual([33]);
    await writeFile(path, `${"\n".repeat(120)}SKU,数量\nA,2\n`);
    const afterBlankPreamble = await analyzeWorkbook(path, "deep");
    expect(afterBlankPreamble.sheets[0]).toMatchObject({ headerRow: 121, rowCount: 1 });
    expect(readTabularSheet(await readWorkbook(path), { headerRows: [121] }).sourceRows).toEqual([122]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("通用 V3 来源补丁", () => {
  it("同名文件按 artifact ID 修正与排除，原文件不变，哈希不符拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctd-patch-"));
    try {
      const path = join(root, "input.csv"), original = "SKU,数量\nA,2\nB,bad\nC,3\n"; await writeFile(path, original);
      const artifact = await analyzeWorkbook(path, "source-file"), sheet = artifact.sheets[0];
      const plan = ProcessPlanV3Schema.parse({ version: 3, planId: "patch-test", revision: 1, rules: { id: "rule", version: 1 }, targetTemplate: { id: "target", version: 1 }, inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: sheet.id, headerRows: [1], columns: [{ columnId: "sku", sourceIndex: 0, sourceHeader: "SKU" }, { columnId: "qty", sourceIndex: 1, sourceHeader: "数量" }] }], steps: [{ operator: "convert", stepId: "converted", input: "source", conversions: [{ columnId: "qty", to: "integer", onError: "isolate" }] }], outputs: [{ sheetId: "out", datasetId: "converted" }] });
      const rules: any = { id: "rule", version: 1, name: "test", status: "published", aliases: {}, steps: plan.steps }, template: any = { id: "target", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "qty", header: "数量", dataType: "integer" }] }] };
      const args = { plan, artifacts: [artifact, { ...artifact, id: "other-file" }], rules, template };
      expect((await executeWorkbookPlanV2(args)).exceptions).toHaveLength(1);
      const patch: NonNullable<TaskRecord["patches"]>[number] = { id: "patch", exceptionId: "error", action: "correct", artifactId: artifact.id, sheetId: sheet.id, sourceRow: 3, columnId: sheet.columns[1].id, inputHash: artifact.sha256, value: "4", createdAt: new Date().toISOString(), createdBy: "reviewer", reason: "独立复核", evidence: "合成样本记录" };
      const corrected = await executeWorkbookPlanV2({ ...args, patches: [patch, { ...patch, id: "exclude", action: "exclude", sourceRow: 2 }] });
      expect(corrected.rows).toEqual([[4], [3]]); expect(corrected.exceptions).toEqual([]);
      expect(await readFile(path, "utf8")).toBe(original);
      expect((await executeWorkbookPlanV2({ ...args, patches: [{ ...patch, artifactId: "other-file" }] })).exceptions).toHaveLength(1);
      await expect(executeWorkbookPlanV2({ ...args, patches: [{ ...patch, inputHash: "changed" }] })).rejects.toThrow(/源文件已变化/);
      await expect(executeWorkbookPlanV2({ ...args, patches: [{ ...patch, sourceRow: 1 }] })).rejects.toThrow(/源行不在输入数据/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
