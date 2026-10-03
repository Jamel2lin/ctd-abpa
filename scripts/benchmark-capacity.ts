import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeWorkbook, executeWorkbookPlanV2, readTabularSheet, readWorkbook, writeTemplatedWorkbookV3 } from "@ctd-abpa/excel";
import { ProcessPlanV3Schema, RuleSetVersionSchema, TargetTemplateVersionSchema } from "@ctd-abpa/types";

const counts = (process.env.BENCHMARK_ROWS ?? "10000,100000").split(",").map(Number);
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 1_000_000)) throw new Error("BENCHMARK_ROWS 必须为 1–1000000 的整数列表");
const output = resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ?? "docs/验收/容量基准-2026-10-03.json");
const directory = await mkdtemp(join(tmpdir(), "ctd-capacity-")), results = [];
try {
  for (const count of counts) {
    const path = join(directory, `input-${count}.csv`);
    await writeFile(path, `SKU,数量\n${Array.from({ length: count }, (_, index) => `S${index % 100},${index % 10 + 1}`).join("\n")}\n`);
    const start = performance.now(), artifact = await analyzeWorkbook(path, `capacity-${count}`), sheet = artifact.sheets[0], analyzedAt = performance.now();
    const steps = [{ operator: "convert", stepId: "converted", input: "source", conversions: [{ columnId: "qty", to: "integer", onError: "isolate" }] }, { operator: "aggregate", stepId: "totals", input: "converted", groupBy: ["sku"], metrics: [{ outputColumnId: "total", function: "sum", columnId: "qty" }] }];
    const rules = RuleSetVersionSchema.parse({ id: "capacity", version: 1, name: "合成容量基准", status: "published", steps });
    const template = TargetTemplateVersionSchema.parse({ id: "capacity", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "sku", header: "SKU", dataType: "text", required: true }, { columnId: "total", header: "总量", dataType: "integer", required: true }] }] });
    const plan = ProcessPlanV3Schema.parse({ version: 3, planId: "capacity", revision: 1, rules: { id: rules.id, version: rules.version }, targetTemplate: { id: template.id, version: template.version }, inputs: [{ bindingId: "source", artifactId: artifact.id, sheetId: sheet.id, headerRows: [1], columns: [{ columnId: "sku", sourceIndex: 0, sourceHeader: "SKU" }, { columnId: "qty", sourceIndex: 1, sourceHeader: "数量" }] }], steps: rules.steps, outputs: [{ sheetId: "out", datasetId: "totals" }] });
    const result = await executeWorkbookPlanV2({ plan, artifacts: [artifact], rules, template }), executedAt = performance.now();
    const targetPath = join(directory, `output-${count}.xlsx`); await writeTemplatedWorkbookV3({ outputs: result.outputs, template, path: targetPath });
    const actual = readTabularSheet(await readWorkbook(targetPath)).rows;
    const expected = new Map<string, number>(); for (let index = 0; index < count; index++) expected.set(`S${index % 100}`, (expected.get(`S${index % 100}`) ?? 0) + index % 10 + 1);
    if (actual.length !== expected.size || actual.some(([sku, qty]) => expected.get(String(sku)) !== Number(qty)) || result.exceptions.length) throw new Error("容量基准黄金结果比对失败");
    results.push({ inputRows: count, inputBytes: (await stat(path)).size, outputRows: actual.length, analyzeMs: Math.round(analyzedAt - start), executeMs: Math.round(executedAt - analyzedAt), totalWithWriteReadMs: Math.round(performance.now() - start), rssBytesAfter: process.memoryUsage().rss, processPeakRssBytes: process.resourceUsage().maxRSS * 1024, goldenComparison: "passed" });
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, workload: "合成 CSV：类型转换、100 SKU 分类求和、XLSX 写出与复读；同进程依次运行，峰值内存为累计值；不含 HTTP 上传与真实多用户并发", results }, null, 2)}\n`);
  console.log(JSON.stringify({ output, results }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
