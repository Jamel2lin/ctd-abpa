import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeWorkbook, executeWorkbookPlanV2 } from "@ctd-abpa/excel";
import { ProcessPlanV2Schema } from "@ctd-abpa/types";

describe("V2 工作簿执行服务", () => {
  it("仅通过任务 artifact/sheet/column ID 绑定并执行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-v2-")), path = join(directory, "input.csv");
    try {
      await writeFile(path, "旧工号,金额\n00123,12.50\n00124,bad\n");
      const artifact = await analyzeWorkbook(path), sheet = artifact.sheets[0];
      const plan = ProcessPlanV2Schema.parse({
        version: 2, planId: "plan.csv", revision: 1, rules: { id: "rules.csv", version: 1 },
        inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: sheet.id, headerRows: [1], columns: [
          { columnId: "legacy_id", sourceIndex: 0, sourceHeader: "旧工号" }, { columnId: "amount", sourceIndex: 1, sourceHeader: "金额" },
        ] }],
        steps: [
          { stepId: "renamed", input: "source", operator: "rename", mappings: [{ from: "legacy_id", to: "employee_id" }] },
          { stepId: "converted", input: "renamed", operator: "convert", conversions: [{ columnId: "amount", to: "decimal", onError: "isolate" }] },
        ], targetTemplate: { id: "template.csv", version: 1 },
      });
      const result = await executeWorkbookPlanV2({
        plan, artifacts: [artifact], rules: { id: "rules.csv", version: 1, name: "CSV", status: "published", aliases: {}, steps: plan.steps },
        template: { id: "template.csv", version: 1, format: "csv", sheets: [{ sheetId: "output", name: "输出", headerRow: 1, columns: [
          { columnId: "employee_id", header: "工号", dataType: "text", required: true }, { columnId: "amount", header: "金额", dataType: "decimal", required: true },
        ] }] },
      });
      expect(result.rows).toEqual([["00123", "12.5"]]);
      expect(result.exceptions).toHaveLength(1); expect(result.exceptions[0].sourceRow).toBe(3);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("文件在确认后变化时拒绝执行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-v2-change-")), path = join(directory, "input.csv");
    try {
      await writeFile(path, "工号\n001\n"); const artifact = await analyzeWorkbook(path); await writeFile(path, "工号\n002\n");
      const plan = ProcessPlanV2Schema.parse({ version: 2, planId: "changed", revision: 1, rules: { id: "changed", version: 1 }, inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: artifact.sheets[0].id, headerRows: [1], columns: [{ columnId: "id", sourceIndex: 0, sourceHeader: "工号" }] }], steps: [], targetTemplate: { id: "changed", version: 1 } });
      await expect(executeWorkbookPlanV2({ plan, artifacts: [artifact], rules: { id: "changed", version: 1, name: "changed", status: "published", aliases: {}, steps: [] }, template: { id: "changed", version: 1, format: "csv", sheets: [{ sheetId: "out", name: "out", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" }] }] } })).rejects.toThrow(/已变化/);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("绑定列位置与原表头不一致时拒绝执行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-v2-header-")), path = join(directory, "input.csv");
    try {
      await writeFile(path, "工号,金额\n001,5\n"); const artifact = await analyzeWorkbook(path);
      const plan = ProcessPlanV2Schema.parse({ version: 2, planId: "wrong-header", revision: 1, rules: { id: "wrong-header", version: 1 }, inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: artifact.sheets[0].id, headerRows: [1], columns: [{ columnId: "id", sourceIndex: 0, sourceHeader: "金额" }] }], steps: [], targetTemplate: { id: "wrong-header", version: 1 } });
      await expect(executeWorkbookPlanV2({ plan, artifacts: [artifact], rules: { id: "wrong-header", version: 1, name: "wrong", status: "published", aliases: {}, steps: [] }, template: { id: "wrong-header", version: 1, format: "csv", sheets: [{ sheetId: "out", name: "out", headerRow: 1, columns: [{ columnId: "id", header: "工号", dataType: "text" }] }] } })).rejects.toThrow(/表头不一致/);
    } finally { await rm(directory, { recursive: true }); }
  });
});
