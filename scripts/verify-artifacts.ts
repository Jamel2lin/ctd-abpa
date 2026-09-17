import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import XLSX from "../packages/excel/node_modules/xlsx/xlsx.mjs";

const expected = [
  { dir: "加班转HR", rows: 35_970, sheet: "Sheet1", columns: 6 },
  { dir: "请假转HR", rows: 13, sheet: "导入HR 格式", columns: 8 },
  { dir: "年假结算", rows: 7, sheet: "导入HR 格式", columns: 8 },
];

for (const item of expected) {
  const path = resolve("outputs/demo", item.dir, "HR导入.xls"), bytes = await readFile(path);
  if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) throw new Error(`${item.dir}: 非 CDFV2/BIFF8`);
  const workbook = XLSX.read(bytes, { type: "buffer", raw: true }), sheet = workbook.Sheets[item.sheet];
  if (!sheet) throw new Error(`${item.dir}: 工作表名错误`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
  if (rows.length - 1 !== item.rows || rows[0].length !== item.columns) throw new Error(`${item.dir}: 行列数错误`);
  for (const address of ["A1", "A2"]) if (sheet[address]?.t !== "s") throw new Error(`${item.dir}: ${address} 不是文本单元格`);
  console.log(`${item.dir}: BIFF8/工作表/行列/文本类型通过`);
}
