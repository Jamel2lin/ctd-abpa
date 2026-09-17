import type { SourceArtifact } from "@ctd-abpa/types";
import { readTabularSheet, readWorkbook, sha256File } from "./workbook.js";

export interface ColumnProfile {
  columnId: string;
  header: string;
  inferredTypes: string[];
  nullRate: number;
  uniqueRate: number;
  minLength?: number;
  maxLength?: number;
  patterns: string[];
  numericRange?: [number, number];
}
export interface SheetProfile { artifactId: string; sheetId: string; rowCount: number; columns: ColumnProfile[]; }
export interface ModelDataProfile { sheets: SheetProfile[]; candidateJoins: Array<{ left: string; right: string; overlapRate: number }>; privateTerms: string[]; }

function pattern(value: string): string {
  return value.slice(0, 32).replace(/[0-9]/g, "9").replace(/[A-Za-z]/g, "A").replace(/[\u4e00-\u9fff]/g, "汉");
}

export async function profileArtifactsForModel(artifacts: SourceArtifact[], instruction = ""): Promise<ModelDataProfile> {
  const sheets: SheetProfile[] = [], privateTerms = new Set<string>();
  const joins: Array<{ id: string; values: Set<string>; uniqueRate: number }> = [];
  for (const artifact of artifacts) {
    if (await sha256File(artifact.path) !== artifact.sha256) throw new Error(`源文件已变化: ${artifact.fileName}`);
    const workbook = await readWorkbook(artifact.path);
    for (const sheet of artifact.sheets) {
      if (!sheet.headers.length) continue;
      const tab = readTabularSheet(workbook, { sheet: sheet.name, headerRows: [sheet.headerRow] });
      const columns: ColumnProfile[] = sheet.columns.map((column) => {
        const values = tab.rows.map((row) => row[column.index]);
        const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "").map(String);
        const unique = new Set(present);
        const numeric = present.map(Number).filter(Number.isFinite);
        const sensitive = /工号|员工编号|人员编号|职工号|姓名|申请人|身份证|电话|手机|邮箱|邮件/i.test(column.header);
        if (sensitive) for (const value of unique) if (value.length >= 2 && instruction.includes(value)) privateTerms.add(value);
        if (/工号|编号|编码|ID|id|SKU|sku/.test(column.header) && unique.size && unique.size === present.length) joins.push({ id: column.id, values: unique, uniqueRate: unique.size / Math.max(1, present.length) });
        return {
          columnId: column.id,
          header: column.header.slice(0, 80),
          inferredTypes: column.inferredTypes,
          nullRate: values.length ? (values.length - present.length) / values.length : 0,
          uniqueRate: present.length ? unique.size / present.length : 0,
          minLength: present.length ? present.reduce((min, value) => Math.min(min, value.length), Infinity) : undefined,
          maxLength: present.length ? present.reduce((max, value) => Math.max(max, value.length), 0) : undefined,
          patterns: [...new Set(present.slice(0, 100).map(pattern))].slice(0, 5),
          numericRange: !sensitive && numeric.length === present.length && numeric.length ? [numeric.reduce((min, value) => Math.min(min, value), Infinity), numeric.reduce((max, value) => Math.max(max, value), -Infinity)] as [number, number] : undefined,
        };
      });
      sheets.push({ artifactId: artifact.id, sheetId: sheet.id, rowCount: tab.rows.length, columns });
    }
  }
  const candidateJoins: ModelDataProfile["candidateJoins"] = [];
  for (let left = 0; left < joins.length; left++) for (let right = left + 1; right < joins.length; right++) {
    if (joins[left].id.split(":")[0] === joins[right].id.split(":")[0]) continue;
    const overlap = [...joins[left].values].filter((value) => joins[right].values.has(value)).length;
    const rate = overlap / Math.max(1, Math.min(joins[left].values.size, joins[right].values.size));
    if (rate >= 0.5) candidateJoins.push({ left: joins[left].id, right: joins[right].id, overlapRate: rate });
  }
  return { sheets, candidateJoins: candidateJoins.slice(0, 20), privateTerms: [...privateTerms] };
}
