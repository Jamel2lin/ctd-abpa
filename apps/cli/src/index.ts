#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { Command } from "commander";
import XLSX from "xlsx";
import { parseInstruction, suggestPlanDetailed, validatePlan, validatePlanV2 } from "@ctd-abpa/core";
import { RuleSetVersionSchema, TargetTemplateVersionSchema } from "@ctd-abpa/types";
import { analyzeWorkbook, executePlan, executeWorkbookPlanV2, writeDeliverables, writeExceptions, writeTemplatedWorkbook } from "@ctd-abpa/excel";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const program = new Command().name("bridge").description("跨系统表格数据桥接").version("0.2.0");

program.command("inspect").argument("<files...>").description("分析工作簿结构").action(async (files: string[]) => {
  const results = await Promise.all(files.map((f) => analyzeWorkbook(resolve(f)))); console.log(JSON.stringify(results, null, 2));
});

program.command("run")
  .option("--plan <file>", "ProcessPlan JSON")
  .option("--instruction <text>", "中文自然语言指令")
  .option("--use-model", "使用配置的模型生成计划").option("--provider <id>", "模型提供商", "deepseek").option("--save-plan <file>", "保存已校验计划")
  .option("--overtime <file>").option("--leave <file>").option("--balance <file>")
  .requiredOption("--output <dir>").option("--allow-stale-balance").option("--confirmed-by <name>", "确认人", "CLI")
  .action(async (opts) => {
    const sources = Object.fromEntries(["overtime", "leave", "balance"].filter((k) => opts[k]).map((k) => [k, resolve(opts[k])]));
    let base;
    if (opts.plan) base = validatePlan(JSON.parse(await readFile(resolve(opts.plan), "utf8")));
    else if (opts.useModel) {
      const artifacts = await Promise.all(Object.values(sources).map((path) => analyzeWorkbook(path)));
      base = (await suggestPlanDetailed({ instruction: opts.instruction ?? "", headers: artifacts.flatMap((file) => file.sheets.map((sheet) => sheet.headers)), rowCounts: artifacts.flatMap((file) => file.sheets.map((sheet) => sheet.rowCount)), inferredTypes: artifacts.flatMap((file) => file.sheets.map((sheet) => sheet.inferredTypes)), sources }, opts.provider)).plan;
    } else base = parseInstruction(opts.instruction ?? "", sources);
    const plan = validatePlan({ ...base, sources: { ...base.sources, ...sources }, allowStaleBalance: Boolean(opts.allowStaleBalance), confirmedBy: opts.confirmedBy });
    if (opts.savePlan) await writeFile(resolve(opts.savePlan), `${JSON.stringify(plan, null, 2)}\n`);
    const result = await executePlan(plan), taskId = crypto.randomUUID(), outputDir = resolve(opts.output);
    const manifest = await writeDeliverables({ taskId, outputDir, result, plan, confirmedBy: opts.confirmedBy });
    console.log(JSON.stringify({ taskId, status: manifest.status, outputDir, reconciliation: manifest.reconciliation, summary: manifest.calculationSummary }, null, 2));
  });

program.command("run-v2")
  .description("使用已发布规则和目标模板执行 V2 计划（不调用模型）")
  .requiredOption("--plan <file>").requiredOption("--rules <file>").requiredOption("--template <file>")
  .requiredOption("--input <files...>").requiredOption("--output <file>")
  .action(async (opts) => {
    const plan = validatePlanV2(JSON.parse(await readFile(resolve(opts.plan), "utf8")));
    const rules = RuleSetVersionSchema.parse(JSON.parse(await readFile(resolve(opts.rules), "utf8")));
    const template = TargetTemplateVersionSchema.parse(JSON.parse(await readFile(resolve(opts.template), "utf8")));
    const artifacts = await Promise.all((opts.input as string[]).map((file) => analyzeWorkbook(resolve(file))));
    const result = await executeWorkbookPlanV2({ plan, artifacts, rules, template });
    const output = resolve(opts.output); await mkdir(resolve(output, ".."), { recursive: true });
    const written = await writeTemplatedWorkbook({ data: result.data, template, path: output });
    const exceptions = [...result.exceptions, ...written.exceptions];
    if (exceptions.length) await writeExceptions(exceptions, `${output}.exceptions.xlsx`);
    console.log(JSON.stringify({ status: exceptions.length ? "completed_with_exceptions" : "completed", output, reconciliation: { ...result.reconciliation, outputRows: written.outputRows, isolatedRows: result.reconciliation.isolatedRows + written.exceptions.length } }, null, 2));
  });

const exceptions = program.command("exceptions");
exceptions.command("export").requiredOption("--from <file>").requiredOption("--output <file>").action(async (opts) => {
  const data = JSON.parse(await readFile(resolve(opts.from), "utf8"));
  await writeFile(resolve(opts.output), `${JSON.stringify(data.exceptions ?? data, null, 2)}\n`);
});
exceptions.command("apply").requiredOption("--log <file>").requiredOption("--resolutions <file>").requiredOption("--output <file>").action(async (opts) => {
  const log = JSON.parse(await readFile(resolve(opts.log), "utf8")); const resolutions = JSON.parse(await readFile(resolve(opts.resolutions), "utf8"));
  const map = new Map(Object.entries(resolutions)); const rows = (log.exceptions ?? log).map((e: any) => ({ ...e, resolution: map.get(e.id) ?? e.resolution }));
  await writeFile(resolve(opts.output), `${JSON.stringify(rows, null, 2)}\n`);
});

program.command("profile").command("validate").argument("<file>").action(async (file) => {
  const profile = JSON.parse(await readFile(resolve(file), "utf8"));
  for (const key of ["id", "version", "name", "sourceKind", "fieldMappings"]) if (profile[key] === undefined) throw new Error(`缺少配置字段: ${key}`);
  console.log(`配置有效: ${profile.id}@${profile.version}`);
});

program.parseAsync().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
