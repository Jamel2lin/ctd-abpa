import type { DataSetV2, ExecuteV2Result } from "@ctd-abpa/core";
import { executePlanV2 } from "@ctd-abpa/core";
import type { DataType, ProcessPlanV2, ProcessPlanV3, RuleSetVersion, Scalar, SourceArtifact, TargetTemplateVersion, TaskRecord } from "@ctd-abpa/types";
import { analyzeWorkbook, readTabularSheet, readWorkbook } from "./workbook.js";

function inferColumnType(values: Scalar[]): DataType {
  const present = values.filter((value) => value !== null);
  if (!present.length) return "text";
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  if (present.every((value) => typeof value === "number" && Number.isInteger(value))) return "integer";
  if (present.every((value) => typeof value === "number")) return "decimal";
  return "text";
}

export async function bindWorkbookInputsV2(plan: ProcessPlanV2 | ProcessPlanV3, artifacts: SourceArtifact[], patches: TaskRecord["patches"] = []): Promise<Record<string, DataSetV2>> {
  const owned = new Map(artifacts.map((artifact) => [artifact.id, artifact])), bindings: Record<string, DataSetV2> = {};
  for (const input of plan.inputs) {
    const artifact = owned.get(input.artifactId);
    if (!artifact) throw new Error(`计划引用了不属于任务的 artifact: ${input.artifactId}`);
    const current = await analyzeWorkbook(artifact.path, artifact.id);
    if (current.id !== artifact.id || current.sha256 !== artifact.sha256) throw new Error(`artifact 内容已变化，原确认失效: ${artifact.fileName}`);
    const sheet = current.sheets.find((candidate) => candidate.id === input.sheetId);
    if (!sheet) throw new Error(`artifact 中不存在工作表 ID: ${input.sheetId}`);
    const tab = readTabularSheet(await readWorkbook(artifact.path), { sheet: sheet.name, headerRows: input.headerRows });
    const selectedPatches = patches.filter((patch) => patch.artifactId === artifact.id && patch.sheetId === sheet.id);
    for (const patch of selectedPatches) {
      if (patch.inputHash !== artifact.sha256) throw new Error(`补丁 ${patch.id} 的源文件已变化`);
      const index = tab.sourceRows.indexOf(patch.sourceRow);
      if (index < 0) throw new Error(`补丁源行不在输入数据中: ${patch.sourceRow}`);
      if (patch.action === "correct") {
        const column = sheet.columns.find((column) => column.id === patch.columnId);
        if (!column || patch.value === undefined) throw new Error("补丁源列或值不存在");
        tab.rows[index][column.index] = patch.value;
      }
    }
    for (const column of input.columns) {
      if (tab.headers[column.sourceIndex] !== column.sourceHeader) throw new Error(`输入绑定表头不一致: ${input.bindingId}.${column.columnId}，请重新确认列位置`);
    }
    const rows = tab.rows.map((cells, index) => ({
      values: Object.fromEntries(input.columns.map((column) => [column.columnId, (cells[column.sourceIndex] ?? null) as Scalar])),
      lineage: input.columns.map((column) => ({ artifactId: artifact.id, sourceFile: artifact.fileName, sourceSheet: sheet.name, sourceRow: tab.sourceRows[index], sourceColumn: column.sourceIndex + 1, columnId: column.columnId })),
    })).filter((row) => !selectedPatches.some((patch) => patch.action === "exclude" && patch.sourceRow === row.lineage[0]?.sourceRow));
    bindings[input.bindingId] = {
      columns: Object.fromEntries(input.columns.map((column) => [column.columnId, inferColumnType(rows.map((row) => row.values[column.columnId]))])),
      rows,
    };
  }
  return bindings;
}

export async function executeWorkbookPlanV2(args: { plan: ProcessPlanV2 | ProcessPlanV3; artifacts: SourceArtifact[]; rules: RuleSetVersion; template: TargetTemplateVersion; allowDraft?: boolean; patches?: TaskRecord["patches"] }): Promise<ExecuteV2Result> {
  return executePlanV2({ ...args, bindings: await bindWorkbookInputsV2(args.plan, args.artifacts, args.patches) });
}
