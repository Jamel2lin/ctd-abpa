import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import JSZip from "jszip";
import XLSX from "xlsx";
import type { ArtifactManifest, ExceptionRecord, ProcessPlan, Scalar, TargetTemplateVersion } from "@ctd-abpa/types";
import { parseLocalDate, type DataSetV2 } from "@ctd-abpa/core";
import { TargetTemplateVersionSchema } from "@ctd-abpa/types";
import { assertBiff8RowLimit, readWorkbook, sha256File } from "./workbook.js";
import type { BalanceAuditRow, ProcessResult } from "./process.js";

function textSheet(rows: string[][]): XLSX.WorkSheet {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (sheet["!ref"]) {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let r = range.s.r; r <= range.e.r; r++) for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell) { cell.t = "s"; cell.v = String(cell.v ?? ""); cell.z = "@"; delete cell.f; }
    }
  }
  return sheet;
}

function setUsefulWidths(sheet: XLSX.WorkSheet, widths: number[]): void { sheet["!cols"] = widths.map((wch) => ({ wch })); }

async function atomicWrite(path: string, bytes: Uint8Array | Buffer | string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, bytes); await rename(temp, path);
}

export async function writeHrXls(result: ProcessResult, path: string): Promise<void> {
  assertBiff8RowLimit(result.rows.length);
  const workbook = XLSX.utils.book_new();
  const sheet = textSheet([result.headers, ...result.rows.map((r) => r.cells)]);
  setUsefulWidths(sheet, result.headers.length === 6 ? [14, 12, 18, 14, 15, 12] : [14, 12, 18, 12, 20, 20, 12, 10]);
  XLSX.utils.book_append_sheet(workbook, sheet, result.sheetName);
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "biff8", cellStyles: true });
  await atomicWrite(path, bytes);
  const reread = await readWorkbook(path), rereadSheet = reread.Sheets[result.sheetName];
  if (!rereadSheet) throw new Error(`输出复读失败：工作表 ${result.sheetName} 缺失`);
  const values = XLSX.utils.sheet_to_json<Scalar[]>(rereadSheet, { header: 1, raw: true, defval: null });
  if (JSON.stringify(values[0]) !== JSON.stringify(result.headers)) throw new Error("输出复读失败：表头不一致");
  if (values.length - 1 !== result.rows.length) throw new Error("输出复读失败：数据行数不一致");
}

function typedCell(value: Scalar, type: TargetTemplateVersion["sheets"][number]["columns"][number]["dataType"]): XLSX.CellObject {
  if (value === null) return { t: "z", v: undefined } as XLSX.CellObject;
  if (type === "text") return { t: "s", v: String(value), z: "@" };
  if (type === "date" || type === "datetime") {
    const text = String(value), match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(text);
    if (!match || (type === "datetime" && match[4] === undefined)) throw new Error(`非法${type === "date" ? "日期" : "日期时间"}: ${text}`);
    const [, year, month, day, hour = "0", minute = "0"] = match;
    parseLocalDate(`${year}-${month}-${day}`); if (Number(hour) > 23 || Number(minute) > 59) throw new Error(`非法日期时间: ${text}`);
    const serial = (Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - Date.UTC(1899, 11, 30)) / 86_400_000;
    return { t: "n", v: serial };
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return { t: "b", v: value };
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "是"].includes(normalized)) return { t: "b", v: true };
    if (["false", "0", "否"].includes(normalized)) return { t: "b", v: false };
    throw new Error(`非法布尔值: ${value}`);
  }
  const text = String(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || text.replace(/[^0-9]/g, "").length > 15) throw new Error(`数值无法安全写入 Excel: ${text}`);
  if (type === "integer" && !Number.isSafeInteger(Number(text))) throw new Error(`非法整数: ${text}`);
  return { t: "n", v: Number(text) };
}

export function prepareTemplatedData(args: { data: DataSetV2; template: TargetTemplateVersion; allowOverflow?: boolean }): { data: DataSetV2; exceptions: ExceptionRecord[] } {
  const template = TargetTemplateVersionSchema.parse(args.template);
  if (template.sheets.length !== 1) throw new Error("多工作表模板需要显式输出绑定；当前计划版本不支持");
  const sheetTemplate = template.sheets[0];
  const exceptions: ExceptionRecord[] = [], accepted: DataSetV2["rows"] = [];
  for (const row of args.data.rows) {
    let failedColumn: TargetTemplateVersion["sheets"][number]["columns"][number] | undefined;
    try {
      for (const column of sheetTemplate.columns) {
        failedColumn = column;
        const value = row.values[column.columnId] ?? column.defaultValue ?? null;
        if (column.required && (value === null || value === "")) throw new Error(`必填列为空: ${column.header}`);
        if (column.maxLength !== undefined && String(value ?? "").length > column.maxLength) throw new Error(`列 ${column.header} 超过最大长度 ${column.maxLength}`);
        typedCell(value, column.dataType);
      }
      accepted.push(row);
    } catch (error) {
      const first = row.lineage[0] ?? { sourceFile: "", sourceSheet: "" }, reason = (error as Error).message;
      exceptions.push({ id: crypto.randomUUID(), code: "TEMPLATE_ROW_INVALID", severity: "error", businessLevel: "L3", disposition: "alert_and_isolate", requiresHumanReview: true, automationAllowed: false, sourceOfTruth: "目标模板", message: reason, sourceFile: first.sourceFile, sourceSheet: first.sourceSheet, sourceRow: first.sourceRow, columnId: failedColumn?.columnId, originalValue: failedColumn ? row.values[failedColumn.columnId] : undefined, ruleId: `${template.id}@${template.version}`, reason, suggestion: "补齐或修正目标模板必填值后重跑", raw: row.values, lineage: row.lineage });
    }
  }
  const capacity = Math.min(sheetTemplate.maxDataRows ?? Infinity, template.format === "xls" ? 65_535 - sheetTemplate.headerRow + 1 : Infinity);
  if (!args.allowOverflow && accepted.length > capacity) throw new Error(`输出超过模板容量 ${capacity} 行（当前 ${accepted.length} 行），请分批处理`);
  return { data: { columns: args.data.columns, rows: accepted }, exceptions };
}

export function prepareTemplatedOutputs(args: { outputs: Record<string, DataSetV2>; template: TargetTemplateVersion; allowOverflow?: boolean }): { outputs: Record<string, DataSetV2>; exceptions: ExceptionRecord[]; outputRows: number } {
  const template = TargetTemplateVersionSchema.parse(args.template);
  if (template.format === "csv" && template.sheets.length !== 1) throw new Error("CSV 格式不支持多工作表");
  const outputs: Record<string, DataSetV2> = {}, exceptions: ExceptionRecord[] = [];
  for (const sheet of template.sheets) {
    const data = args.outputs[sheet.sheetId];
    if (!data) throw new Error(`缺少输出工作表绑定: ${sheet.sheetId}`);
    const prepared = prepareTemplatedData({ data, template: { ...template, sheets: [sheet] }, allowOverflow: args.allowOverflow });
    outputs[sheet.sheetId] = prepared.data;
    exceptions.push(...prepared.exceptions);
  }
  return { outputs, exceptions, outputRows: Object.values(outputs).reduce((count, data) => count + data.rows.length, 0) };
}

export function batchTemplatedOutputs(args: { outputs: Record<string, DataSetV2>; template: TargetTemplateVersion }): { outputs: Record<string, DataSetV2>; batches: Array<Record<string, DataSetV2>>; exceptions: ExceptionRecord[]; outputRows: number } {
  const template = TargetTemplateVersionSchema.parse(args.template);
  const prepared = prepareTemplatedOutputs({ ...args, allowOverflow: true });
  const capacity = Object.fromEntries(template.sheets.map((sheet) => [sheet.sheetId, Math.min(sheet.maxDataRows ?? Infinity, template.format === "xls" ? 65_536 - sheet.headerRow : Infinity)]));
  if (Object.values(capacity).some((limit) => limit < 1)) throw new Error("模板表头已占满工作表容量");
  const count = Math.max(1, ...template.sheets.map((sheet) => Math.ceil(prepared.outputs[sheet.sheetId].rows.length / capacity[sheet.sheetId])));
  const batches = Array.from({ length: count }, (_, index) => Object.fromEntries(template.sheets.map((sheet) => {
    const data = prepared.outputs[sheet.sheetId], limit = capacity[sheet.sheetId];
    const rows = Number.isFinite(limit) ? data.rows.slice(index * limit, (index + 1) * limit) : index === 0 ? data.rows : [];
    return [sheet.sheetId, { columns: data.columns, rows }];
  })));
  return { ...prepared, batches };
}

export async function writeTemplatedWorkbookV3(args: { outputs: Record<string, DataSetV2>; template: TargetTemplateVersion; path: string }): Promise<{ outputRows: number; exceptions: ExceptionRecord[] }> {
  const template = TargetTemplateVersionSchema.parse(args.template);
  if (extname(args.path).toLowerCase() !== `.${template.format}`) throw new Error(`输出扩展名必须与模板格式一致: .${template.format}`);
  const prepared = prepareTemplatedOutputs(args), workbook = XLSX.utils.book_new();
  for (const sheet of template.sheets) {
    const headers = sheet.columns.map((column) => ({ t: "s", v: column.header, z: "@" }) as XLSX.CellObject);
    const leading = Array.from({ length: sheet.headerRow - 1 }, () => [] as XLSX.CellObject[]);
    const body = prepared.outputs[sheet.sheetId].rows.map((row) => sheet.columns.map((column) => {
      const cell = typedCell(row.values[column.columnId] ?? column.defaultValue ?? null, column.dataType);
      if (column.numberFormat) cell.z = column.numberFormat;
      return cell;
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([...leading, headers, ...body]), sheet.name);
  }
  await atomicWrite(args.path, XLSX.write(workbook, { type: "buffer", bookType: template.format === "xls" ? "biff8" : template.format, cellStyles: true }));
  const reread = await readWorkbook(args.path);
  if (reread.SheetNames.length !== template.sheets.length) throw new Error("输出复读失败：工作表数量不一致");
  for (const sheet of template.sheets) {
    const actual = reread.Sheets[sheet.name] as unknown as { "!data"?: Array<Array<{ t?: string; v?: unknown; z?: string } | undefined>> };
    if (!actual) throw new Error(`输出复读失败：工作表 ${sheet.name} 缺失`);
    const expectedRows = prepared.outputs[sheet.sheetId].rows;
    const values = XLSX.utils.sheet_to_json<Scalar[]>(reread.Sheets[sheet.name], { header: 1, raw: true, defval: null, blankrows: true });
    if (JSON.stringify((values[sheet.headerRow - 1] ?? []).slice(0, sheet.columns.length).map(String)) !== JSON.stringify(sheet.columns.map((column) => column.header))) throw new Error(`输出复读失败：工作表 ${sheet.name} 表头不一致`);
    if (values.length - sheet.headerRow !== expectedRows.length) throw new Error(`输出复读失败：工作表 ${sheet.name} 行数不一致`);
    for (let row = 0; row < expectedRows.length; row++) for (let column = 0; column < sheet.columns.length; column++) {
      const spec = sheet.columns[column], expected = typedCell(expectedRows[row].values[spec.columnId] ?? spec.defaultValue ?? null, spec.dataType);
      const found = actual["!data"]?.[sheet.headerRow + row]?.[column];
      if (expected.t !== "z" && (found?.t !== expected.t || String(found?.v) !== String(expected.v))) throw new Error(`输出复读失败：${sheet.name} 第 ${row + 1} 行第 ${column + 1} 列值或类型不一致`);
      if (expected.t === "z" && found?.v != null) throw new Error(`输出复读失败：${sheet.name} 第 ${row + 1} 行第 ${column + 1} 列应为空`);
      if (spec.numberFormat && found?.z !== spec.numberFormat) throw new Error(`输出复读失败：${sheet.name} 第 ${row + 1} 行第 ${column + 1} 列格式不一致`);
    }
  }
  return { outputRows: prepared.outputRows, exceptions: prepared.exceptions };
}

export async function writeTemplatedWorkbook(args: { data: DataSetV2; template: TargetTemplateVersion; path: string }): Promise<{ outputRows: number; exceptions: ExceptionRecord[] }> {
  const template = TargetTemplateVersionSchema.parse(args.template), sheetTemplate = template.sheets[0];
  if (extname(args.path).toLowerCase() !== `.${template.format}`) throw new Error(`输出扩展名必须与模板格式一致: .${template.format}`);
  const prepared = prepareTemplatedData({ data: args.data, template });
  const body: XLSX.CellObject[][] = prepared.data.rows.map((row) => sheetTemplate.columns.map((column) => {
    const cell = typedCell(row.values[column.columnId] ?? column.defaultValue ?? null, column.dataType);
    if (column.numberFormat) cell.z = column.numberFormat;
    return cell;
  }));
  const headers = sheetTemplate.columns.map((column) => ({ t: "s", v: column.header, z: "@" }) as XLSX.CellObject);
  const leading = Array.from({ length: sheetTemplate.headerRow - 1 }, () => [] as XLSX.CellObject[]);
  const sheet = XLSX.utils.aoa_to_sheet([...leading, headers, ...body]);
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, sheetTemplate.name);
  const bookType = template.format === "xls" ? "biff8" : template.format;
  const bytes = XLSX.write(workbook, { type: "buffer", bookType, cellStyles: true }); await atomicWrite(args.path, bytes);
  const reread = await readWorkbook(args.path), outputSheet = reread.Sheets[sheetTemplate.name] ?? (template.format === "csv" ? reread.Sheets[reread.SheetNames[0]] : undefined);
  if (!outputSheet) throw new Error(`输出复读失败：工作表 ${sheetTemplate.name} 缺失`);
  const values = XLSX.utils.sheet_to_json<Scalar[]>(outputSheet, { header: 1, raw: true, defval: null, blankrows: true });
  const actualHeaders = (values[sheetTemplate.headerRow - 1] ?? []).slice(0, headers.length).map(String);
  if (JSON.stringify(actualHeaders) !== JSON.stringify(sheetTemplate.columns.map((column) => column.header))) throw new Error("输出复读失败：模板表头不一致");
  if (values.filter((_, index) => index >= sheetTemplate.headerRow).length !== body.length) throw new Error("输出复读失败：模板数据行数不一致");
  if (template.format !== "csv") {
    const dense = outputSheet as unknown as { "!data"?: Array<Array<{ t?: string; v?: unknown; z?: string } | undefined>> };
    for (let row = 0; row < body.length; row++) for (let column = 0; column < sheetTemplate.columns.length; column++) {
      const expected = body[row][column], actual = dense["!data"]?.[sheetTemplate.headerRow + row]?.[column];
      if (expected.t !== "z" && (actual?.t !== expected.t || String(actual?.v) !== String(expected.v))) throw new Error(`输出复读失败：第 ${row + 1} 行第 ${column + 1} 列值或类型不一致`);
      if (expected.t === "z" && actual?.v != null) throw new Error(`输出复读失败：第 ${row + 1} 行第 ${column + 1} 列应为空`);
      const numberFormat = sheetTemplate.columns[column].numberFormat;
      if (numberFormat && actual?.z !== numberFormat) throw new Error(`输出复读失败：第 ${row + 1} 行第 ${column + 1} 列数字格式不一致`);
    }
  }
  return { outputRows: body.length, exceptions: prepared.exceptions };
}

export function writeXlsxWorkbook(sheets: Array<{ name: string; rows: Array<Array<string | number>>; widths: number[] }>, path: string): Promise<void> {
  const workbook = XLSX.utils.book_new();
  for (const item of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(item.rows);
    setUsefulWidths(sheet, item.widths);
    XLSX.utils.book_append_sheet(workbook, sheet, item.name);
  }
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true });
  return atomicWrite(path, bytes);
}

export async function writeExceptions(exceptions: ExceptionRecord[], path: string): Promise<void> {
  const headers = ["异常ID", "技术级别", "业务等级", "处置方式", "需人工复核", "允许自动处理", "权威来源", "异常码", "说明", "源文件", "工作表", "源行号", "源列号", "字段ID", "原值", "规则ID", "原因", "修正建议", "工号", "处理结果", "来源追踪", "原始数据"];
  const rows = exceptions.map((e) => [e.id, e.severity, e.businessLevel, e.disposition, e.requiresHumanReview ? "是" : "否", e.automationAllowed ? "是" : "否", e.sourceOfTruth, e.code, e.message, e.sourceFile, e.sourceSheet, e.sourceRow ?? "", e.sourceColumn ?? "", e.columnId ?? "", JSON.stringify(e.originalValue ?? ""), e.ruleId ?? "", e.reason ?? e.message, e.suggestion ?? "", e.employeeId ?? "", e.resolution ?? "", JSON.stringify(e.lineage ?? []), JSON.stringify(e.raw ?? {})]);
  await writeXlsxWorkbook([{ name: "异常日志", rows: [headers, ...rows], widths: [38, 10, 10, 22, 12, 14, 22, 28, 36, 28, 18, 10, 10, 20, 24, 22, 36, 44, 14, 22, 60, 80] }], path);
}

export async function writeBalanceAudit(rows: BalanceAuditRow[], path: string): Promise<void> {
  const headers = ["工号", "姓名", "部门", "余额时点", "期初年假小时", "抵扣小时", "期末年假小时"];
  const body = rows.map((r) => [r.employeeId, r.name, r.department, r.balanceAsOf, r.openingMinutes / 60, r.deductedMinutes / 60, r.closingMinutes / 60]);
  await writeXlsxWorkbook([{ name: "年假余额对账", rows: [headers, ...body], widths: [14, 12, 18, 12, 16, 14, 16] }], path);
}

export async function writeDeliverables(args: { taskId: string; outputDir: string; result: ProcessResult; plan: ProcessPlan; confirmedBy?: string; approval?: ArtifactManifest["approval"]; patches?: ArtifactManifest["patches"] }): Promise<ArtifactManifest> {
  const { taskId, outputDir, result, plan } = args;
  await mkdir(outputDir, { recursive: true });
  const files: string[] = [];
  const hr = join(outputDir, "HR导入.xls"); await writeHrXls(result, hr); files.push(hr);
  const errorLog = join(outputDir, "异常日志.xlsx"); await writeExceptions(result.exceptions, errorLog); files.push(errorLog);
  if (result.balanceAudit.length) { const audit = join(outputDir, "年假余额对账.xlsx"); await writeBalanceAudit(result.balanceAudit, audit); files.push(audit); }
  const inputPaths = [...new Set(Object.values(plan.sources))];
  const manifest: ArtifactManifest = {
    taskId, status: result.exceptions.some((e) => e.severity === "error") ? "completed_with_exceptions" : "completed",
    createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    inputs: await Promise.all(inputPaths.map(async (p) => ({ fileName: basename(p), sha256: await sha256File(p) }))),
    approval: args.approval, patches: args.patches, outputs: [], profileVersions: { builtin: 1 }, plan,
    reconciliation: { inputRows: result.sourceCount, outputRows: result.rows.length, errorRecords: result.exceptions.filter((e) => e.severity === "error").length }, stages: result.stages,
    calculationSummary: result.summary,
    exceptions: { total: result.exceptions.length, warnings: result.exceptions.filter((e) => e.severity === "warning").length, errors: result.exceptions.filter((e) => e.severity === "error").length, resolved: result.exceptions.filter((e) => e.resolution).length },
    confirmations: plan.allowStaleBalance && result.isStaleBalance ? [{ type: "stale_balance", confirmedBy: args.confirmedBy ?? plan.confirmedBy ?? "CLI", confirmedAt: args.approval?.confirmedAt ?? new Date().toISOString(), details: { balanceAsOf: result.summary.balanceAsOfNumeric, ...(result.balanceAsOf ? { balanceAsOfText: result.balanceAsOf } : {}), ...(result.latestLeaveDate ? { latestLeaveDate: result.latestLeaveDate } : {}), reason: result.staleBalanceReason, evidence: plan.staleBalanceEvidence } }] : [],
  };
  const manifestPath = join(outputDir, "审计清单.json");
  manifest.outputs = await Promise.all(files.map(async (p) => ({ fileName: basename(p), sha256: await sha256File(p), bytes: (await stat(p)).size })));
  await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  files.push(manifestPath);
  const zip = new JSZip();
  for (const file of files) zip.file(basename(file), await readFile(file));
  const zipPath = join(outputDir, "任务产物.zip"); await atomicWrite(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return manifest;
}

export function hashRows(rows: string[][]): string { return createHash("sha256").update(JSON.stringify(rows)).digest("hex"); }
