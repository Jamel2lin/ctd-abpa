import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import XLSX from "xlsx";
import { FIELD_ALIASES, matchFields } from "@ctd-abpa/core";
import type { ArtifactKind, SheetAnalysis, SourceArtifact } from "@ctd-abpa/types";

export type CellValue = string | number | boolean | null;
export interface TabularSheet { name: string; headerRow: number; headers: string[]; rows: CellValue[][]; sourceRows: number[]; }

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function supported(path: string): void {
  if (![".xls", ".xlsx", ".csv"].includes(extname(path).toLowerCase())) throw new Error(`不支持的文件格式: ${extname(path)}`);
}

function fingerprint(headers: string[]): string {
  return createHash("sha256").update(headers.map((h) => h.trim()).join("\u001f")).digest("hex");
}

export async function readWorkbook(path: string): Promise<XLSX.WorkBook> {
  supported(path);
  const bytes = await readFile(path);
  try {
    if (extname(path).toLowerCase() === ".csv") {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
      return XLSX.read(text.replace(/^\uFEFF/, ""), { type: "string", raw: true, cellDates: false, cellNF: true, cellStyles: true, dense: true });
    }
    return XLSX.read(bytes, { type: "buffer", raw: true, cellDates: false, cellNF: true, cellStyles: true, dense: true });
  }
  catch (error) { throw new Error(`工作簿损坏或无法读取: ${(error as Error).message}`); }
}

function rowsOf(sheet: XLSX.WorkSheet): CellValue[][] {
  return XLSX.utils.sheet_to_json<CellValue[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
}

export async function previewWorkbookRows(path: string, sheetName: string): Promise<Array<{ sourceRow: number; cells: CellValue[] }>> {
  const workbook = await readWorkbook(path);
  if (!workbook.Sheets[sheetName]) throw new Error("工作表不存在");
  return rowsOf(workbook.Sheets[sheetName]).slice(0, 100).map((cells, index) => ({ sourceRow: index + 1, cells }));
}

export function detectHeaderRow(rows: CellValue[][]): number {
  let best = -1, score = -1;
  for (let i = 0; i < Math.min(100, rows.length); i++) {
    const values = (rows[i] ?? []).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (!values.length) continue;
    const recognized = Object.values(FIELD_ALIASES).filter((aliases) => values.some((value) => aliases.includes(value))).length;
    const candidate = recognized * 100 + new Set(values).size;
    if (candidate > score) { score = candidate; best = i; }
  }
  // 空白前言不能阻断上传，否则用户没有机会通过工作台显式指定表头。
  if (best < 0) best = rows.findIndex((row) => row.some((value) => value !== null && String(value ?? "").trim() !== ""));
  if (best < 0) throw new Error("工作表内未找到表头");
  return best;
}

export interface ReadSheetOptions { sheet?: string; headerRows?: number[]; }

export function readTabularSheet(workbook: XLSX.WorkBook, requested?: string | ReadSheetOptions): TabularSheet {
  const options = typeof requested === "string" ? { sheet: requested } : requested ?? {};
  const requestedSheet = options.sheet;
  const name = requestedSheet ?? workbook.SheetNames.find((n) => {
    const rows = rowsOf(workbook.Sheets[n]);
    return rows.some((r) => r.some((v) => v !== null && String(v).trim() !== ""));
  });
  if (!name || !workbook.Sheets[name]) throw new Error(`必要工作表缺失: ${requestedSheet ?? "非空工作表"}`);
  const all = rowsOf(workbook.Sheets[name]);
  const selectedHeaderRows = options.headerRows?.length ? [...new Set(options.headerRows)].sort((a, b) => a - b) : [detectHeaderRow(all) + 1];
  if (selectedHeaderRows.some((row) => !Number.isInteger(row) || row < 1 || row > all.length)) throw new Error("表头行超出工作表范围");
  const headerRow = selectedHeaderRows.at(-1)! - 1;
  const width = Math.max(...selectedHeaderRows.map((row) => all[row - 1]?.length ?? 0));
  const headers = Array.from({ length: width }, (_, column) => selectedHeaderRows.map((row) => String(all[row - 1]?.[column] ?? "").trim()).filter(Boolean).join("/"));
  const rows: CellValue[][] = [], sourceRows: number[] = [];
  for (let i = headerRow + 1; i < all.length; i++) {
    const row = (all[i] ?? []).slice(0, width);
    while (row.length < width) row.push(null);
    if (row.every((v) => v === null || String(v).trim() === "")) continue;
    rows.push(row); sourceRows.push(i + 1);
  }
  return { name, headerRow: headerRow + 1, headers, rows, sourceRows };
}

function inferKind(headers: string[]): ArtifactKind {
  let fields: Record<string, number>;
  try { fields = matchFields(headers); } catch { return "unknown"; }
  if (fields.overtimeHours !== undefined) return "overtime";
  if (fields.annualBalance !== undefined) return "annual_balance";
  if (fields.leaveType !== undefined && fields.documentNo !== undefined) return "leave";
  if (headers.includes("缺勤类别") && headers.includes("免打卡")) return "template";
  return "unknown";
}

export async function analyzeWorkbook(path: string, artifactId?: string, headerOverrides: Record<string, number[]> = {}): Promise<SourceArtifact> {
  const workbook = await readWorkbook(path);
  const sha256 = await sha256File(path);
  const sheets: SheetAnalysis[] = workbook.SheetNames.map((name, sheetIndex) => {
    const sheetId = `sheet-${sheetIndex + 1}-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
    const all = rowsOf(workbook.Sheets[name]);
    if (!all.some((r) => r.some((v) => v !== null && String(v).trim() !== ""))) {
      return { id: sheetId, name, rowCount: 0, columnCount: 0, headerRow: 0, headers: [], duplicateHeaders: [], emptyRows: [], inferredTypes: {}, fingerprint: fingerprint([]), columns: [] };
    }
    const tab = readTabularSheet(workbook, { sheet: name, headerRows: headerOverrides[sheetId] });
    const h = tab.headerRow - 1, headers = tab.headers;
    const duplicates = headers.filter((v, i) => v && headers.indexOf(v) !== i);
    const emptyRows: number[] = [], inferred = new Map<string, Set<string>>();
    headers.forEach((x) => inferred.set(x, new Set()));
    for (let r = h + 1; r < all.length; r++) {
      if ((all[r] ?? []).every((v) => v === null || String(v).trim() === "")) emptyRows.push(r + 1);
      headers.forEach((header, c) => {
        const value = all[r]?.[c]; if (value === null || value === undefined || value === "") return;
        inferred.get(header)?.add(typeof value);
      });
    }
    const inferredTypes = Object.fromEntries([...inferred].map(([k, v]) => [k, [...v]]));
    const columns = headers.map((header, index) => ({ id: `${sheetId}:column-${index + 1}`, index, header, inferredTypes: inferredTypes[header] ?? [] }));
    return { id: sheetId, name, rowCount: Math.max(0, all.length - h - 1 - emptyRows.length), columnCount: headers.length, headerRow: h + 1, headers, duplicateHeaders: [...new Set(duplicates)], emptyRows, inferredTypes, fingerprint: fingerprint(headers), columns };
  });
  const nonEmpty = sheets.find((s) => headerOverrides[s.id]) ?? sheets.find((s) => s.rowCount > 0 || s.headers.length > 0);
  return { id: artifactId ?? `artifact-${sha256}`, fileName: path.split("/").pop()!, path, sha256, kind: nonEmpty ? inferKind(nonEmpty.headers) : "unknown", sheets };
}

export function assertBiff8RowLimit(dataRows: number): void {
  if (dataRows > 65_535) throw new Error(`BIFF8 输出超过 65,535 条数据限制（当前 ${dataRows} 条），请筛选或分批处理`);
}
