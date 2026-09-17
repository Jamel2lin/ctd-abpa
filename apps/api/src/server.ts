import { createReadStream } from "node:fs";
import { loadEnvFile } from "node:process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { FIELD_ALIASES, RuleRevisionConflictError, TaskRevisionConflictError, TaskStore, applyRulePatch, assertConfirmationCurrent, diffRuleRevisions, invalidateConfirmation, parseInstruction, planBindingHash, preflightPlanV2, promptHash, publicModelStatus, restoreRuleRevision, sourceIdentityScope, suggestMappings, suggestPlanDetailed, suggestPlanV2Detailed, suggestRuleDraftV3Detailed, suggestRulePatchDetailed, transitionRuleStatus, validatePlan } from "@ctd-abpa/core";
import { analyzeWorkbook, batchTemplatedOutputs, bindWorkbookInputsV2, executePlan, executeWorkbookPlanV2, profileArtifactsForModel, sha256File, writeDeliverables, writeExceptions, writeTemplatedWorkbookV3, type SourcePatch } from "@ctd-abpa/excel";
import { ProcessPlanV2Schema, ProcessPlanV3Schema, RulePatchSchema, RuleSetVersionSchema, SourceIdentitySchema, StableIdSchema, TargetTemplateVersionSchema, type ProcessPlan, type ProcessPlanV2, type ProcessPlanV3, type SourceArtifact, type TaskRecord } from "@ctd-abpa/types";

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const app = Fastify({ logger: true, bodyLimit: 100 * 1024 * 1024 });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof TaskRevisionConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof RuleRevisionConflictError) return reply.code(409).send({ error: error.message });
  const failure = error as Error & { statusCode?: number };
  return reply.code(failure.statusCode ?? 500).send({ error: failure.message });
});
app.addHook("preHandler", async (req, reply) => {
  if (!["POST", "PUT", "DELETE"].includes(req.method)) return;
  const path = req.url.split("?")[0];
  const match = /^\/api\/tasks\/([^/]+)\/(?:files|analyze|sources|plan|v2\/plan|v2\/suggest|v2\/preview|v3\/propose|messages|patches|mappings|mapping-suggestions|preview|confirm|v2\/confirm|rerun)(?:\/|$)/.exec(path);
  if (!match) return;
  const task = await store.get(match[1]);
  if (task.status === "running") return reply.code(409).send({ error: "任务运行中，输入、计划和映射已锁定" });
});
await app.register(cors, { origin: true }); await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 5 } });
const store = new TaskStore(resolve(process.env.TASK_STORAGE_DIR ?? ".tasks"));
await store.recoverInterrupted();
const configRoot = resolve(process.env.CONFIG_STORAGE_DIR ?? ".config");
let executionQueue: Promise<void> = Promise.resolve();
async function waitForExecutionSlot(): Promise<void> {
  const delay = Number(process.env.EXECUTION_QUEUE_DELAY_MS ?? 0);
  if (!Number.isInteger(delay) || delay < 0 || delay > 10_000) throw new Error("执行队列等待时间必须为 0–10000 毫秒");
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}
class RunCancelledError extends Error { constructor() { super("运行已取消"); } }
class InputChangedError extends Error { readonly statusCode = 409; }
async function runCheckpoint(task: TaskRecord): Promise<void> {
  const current = await store.get(task.id);
  if (current.cancelRequested) throw new RunCancelledError();
  if (current.revision !== task.revision) throw new TaskRevisionConflictError(task.id);
}
async function saveRunState(task: TaskRecord): Promise<void> { await runCheckpoint(task); await store.save(task); }
async function finishRunError(task: TaskRecord, version: number, error: unknown): Promise<TaskRecord> {
  const current = await store.get(task.id), cancelled = error instanceof RunCancelledError || current.cancelRequested === true;
  if (error instanceof InputChangedError) { invalidateConfirmation(current); current.workflowStage = "analyze"; }
  current.cancelRequested = false;
  current.error = cancelled ? "运行已取消" : (error as Error).message;
  current.status = cancelled ? "cancelled" : "failed";
  current.progress = { phase: cancelled ? "cancelled" : "failed", completed: 0, total: 3, message: current.error };
  const run = current.runs?.find((item) => item.version === version);
  if (run) { run.status = current.status; run.completedAt = new Date().toISOString(); }
  await store.save(current);
  Object.assign(task, current);
  return current;
}

function message(role: "user" | "assistant", content: string, modelCall?: any) { return { id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString(), modelCall }; }
function taskSources(task: Awaited<ReturnType<TaskStore["get"]>>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const kind of ["overtime", "leave", "annual_balance"] as const) {
    const candidates = task.files.filter((file) => file.kind === kind);
    if (candidates.length > 1) throw new Error(`存在多个 ${kind} 文件，请先明确选择 artifact ID`);
    if (candidates[0]) entries.push([kind === "annual_balance" ? "balance" : kind, candidates[0].path]);
  }
  return Object.fromEntries(entries);
}
async function verifyTaskInputs(task: TaskRecord): Promise<void> {
  for (const file of task.files) {
    let currentHash: string | undefined;
    try { currentHash = await sha256File(file.path); } catch { currentHash = undefined; }
    if (currentHash === file.sha256) continue;
    if (task.status !== "running") { invalidateConfirmation(task); task.status = "analyzed"; task.workflowStage = "analyze"; await store.save(task); }
    throw new InputChangedError(`源文件内容已变化，请恢复原文件或重新分析并确认: ${file.fileName}`);
  }
}
async function buildPlan(task: Awaited<ReturnType<TaskStore["get"]>>, instruction: string, useModel: boolean, provider?: any): Promise<ProcessPlan> {
  const sources = taskSources(task); task.conversation ??= []; task.conversation.push(message("user", instruction));
  if (useModel) {
    const history = task.conversation.filter((item) => item.role === "user").slice(0, -1).slice(-5).map((item) => item.content);
    const { privateTerms, ...profile } = await profileArtifactsForModel(task.files, [instruction, ...history].join("\n"));
    const suggested = await suggestPlanDetailed({ instruction, history, headers: task.files.flatMap((file) => file.sheets.map((sheet) => sheet.headers)), rowCounts: task.files.flatMap((file) => file.sheets.map((sheet) => sheet.rowCount)), inferredTypes: task.files.flatMap((file) => file.sheets.map((sheet) => sheet.inferredTypes)), sources, profile, privateTerms }, provider);
    task.conversation.push(message("assistant", "已生成结构化计划，等待本地预览与确认。", { ...suggested.call, repairRounds: suggested.repairRounds, requestSummaryHash: promptHash({ instruction: "redacted", headers: contextHeaders(task) }), stages: { transport: "passed", structure: "passed", semantics: "passed" }, status: "success" })); return suggested.plan;
  }
  const plan = parseInstruction(instruction, sources); task.conversation.push(message("assistant", "已使用本地已确认规则生成计划。")); return plan;
}
async function sourcePatches(task: Awaited<ReturnType<TaskStore["get"]>>): Promise<SourcePatch[]> {
  return Promise.all((task.patches ?? []).map(async (patch) => {
    const artifact = task.files.find((file) => file.id === patch.artifactId), sheet = artifact?.sheets.find((item) => item.id === patch.sheetId);
    if (!artifact || !sheet || artifact.sha256 !== patch.inputHash || await sha256File(artifact.path) !== patch.inputHash) throw new Error(`补丁 ${patch.id} 的源文件已变化，需重新确认`);
    const column = sheet.columns.find((item) => item.id === patch.columnId);
    if (patch.action === "correct" && !column) throw new Error(`补丁 ${patch.id} 的源列不存在`);
    return { sourcePath: artifact.path, sourceSheet: sheet.name, sourceRow: patch.sourceRow, sourceIndex: column?.index, action: patch.action, value: patch.value };
  }));
}
function sourceAliases(task: Awaited<ReturnType<TaskStore["get"]>>): Record<string, Record<string, string[]>> {
  return Object.fromEntries(task.files.map((file) => {
    const sheet = file.sheets.find((item) => item.rowCount > 0);
    const identity = sourceIdentityFor(task, file);
    const confirmed = sheet && identity ? store.mappings(identity.id, sheet.fingerprint).filter((item) => item.active && item.structureCompatible && sheet.headers.includes(item.sourceHeader) && item.standardField in FIELD_ALIASES) : [];
    return [file.path, Object.fromEntries(confirmed.map((item) => [item.standardField, [item.sourceHeader]]))];
  }));
}
function contextHeaders(task: TaskRecord) { return task.files.flatMap((file) => file.sheets.map((sheet) => sheet.headers)); }

function inferredSourceIdentity(file: SourceArtifact) {
  const known: Partial<Record<SourceArtifact["kind"], [string, string]>> = { overtime: ["erp", "overtime"], leave: ["oa", "leave"], annual_balance: ["hr", "annual-balance"] };
  const identity = known[file.kind]; if (!identity) return undefined;
  return SourceIdentitySchema.parse({ id: sourceIdentityScope(identity[0], identity[1]), system: identity[0], reportType: identity[1] });
}
function sourceIdentityFor(task: TaskRecord, file: SourceArtifact) { return task.sourceIdentities?.[file.id] ?? inferredSourceIdentity(file); }

app.get("/health", async () => ({ ok: true }));
app.get("/api/fields", async () => FIELD_ALIASES);
app.get("/api/models/status", async () => publicModelStatus());
app.get("/api/tasks", async () => store.list());
app.post("/api/tasks", async () => store.create());
app.get("/api/tasks/:id", async (req) => store.get((req.params as any).id));
app.get("/api/tasks/:id/runs", async (req) => (await store.get((req.params as any).id)).runs ?? []);
async function requestRunCancellation(id: string, version?: number): Promise<TaskRecord> {
  const task = await store.get(id);
  if (task.status !== "running") throw new Error("当前任务没有运行中的版本");
  if (version !== undefined && !task.runs?.some((run) => run.version === version && run.status === "running")) throw new Error("指定运行版本不存在或已结束");
  if (!task.cancelRequested) { task.cancelRequested = true; task.progress = { phase: "queued", completed: 0, total: 3, message: "正在取消运行" }; await store.save(task); }
  return task;
}
app.post("/api/tasks/:id/cancel", async (req) => requestRunCancellation((req.params as { id: string }).id));
app.post("/api/tasks/:id/runs/:version/cancel", async (req) => { const { id, version } = req.params as { id: string; version: string }; return requestRunCancellation(id, Number(version)); });
app.get("/api/tasks/:id/mappings", async (req) => {
  const task = await store.get((req.params as any).id);
  return task.files.flatMap((file) => file.sheets.map((sheet) => { const identity = sourceIdentityFor(task, file); return { artifactId: file.id, sheetId: sheet.id, sourceIdentity: identity, structureFingerprint: sheet.fingerprint, mappings: identity ? store.mappings(identity.id, sheet.fingerprint) : [] }; }));
});
app.post("/api/tasks/:id/sources/:artifactId/bind", async (req) => {
  const task = await store.get((req.params as any).id), { artifactId } = req.params as { artifactId: string }, body = req.body as any;
  if (!task.files.some((file) => file.id === artifactId)) throw new Error("来源文件不属于当前任务");
  const identity = SourceIdentitySchema.parse({ id: sourceIdentityScope(String(body.system ?? ""), String(body.reportType ?? "")), system: body.system, reportType: body.reportType });
  task.sourceIdentities ??= {}; task.sourceIdentities[artifactId] = identity; invalidateConfirmation(task); task.workflowStage = "retrieve_rules"; await store.save(task); return identity;
});
app.post("/api/tasks/:id/mappings/confirm", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any;
  if (task.status === "running") throw new Error("运行中任务不能修改映射");
  const artifact = task.files.find((file) => file.id === body.artifactId), sheet = artifact?.sheets.find((item) => item.id === body.sheetId);
  if (!artifact || !sheet || !(String(body.standardField) in FIELD_ALIASES) || !sheet.headers.includes(String(body.sourceHeader))) throw new Error("字段映射必须引用任务内的真实工作表列和已知标准字段");
  const identity = sourceIdentityFor(task, artifact); if (!identity) throw new Error("未知来源必须先绑定来源系统和报表类型");
  const memory = store.confirmMapping({ sourceScope: identity.id, structureFingerprint: sheet.fingerprint, standardField: String(body.standardField), sourceHeader: String(body.sourceHeader), confirmedBy: String(body.confirmedBy ?? "Web用户"), evidence: String(body.evidence ?? "用户逐项确认") });
  invalidateConfirmation(task); if (task.plan) { task.status = "awaiting_confirmation"; task.workflowStage = "preview"; } await store.save(task);
  return memory;
});
app.post("/api/tasks/:id/mappings/:mappingId/deactivate", async (req) => {
  const task = await store.get((req.params as any).id), mappingId = (req.params as { mappingId: string }).mappingId;
  if (task.status === "running") throw new Error("运行中任务不能修改映射");
  const owned = task.files.some((file) => { const identity = sourceIdentityFor(task, file); return identity && file.sheets.some((sheet) => store.mappings(identity.id, sheet.fingerprint).some((item) => item.id === mappingId)); });
  if (!owned) throw new Error("映射不属于当前来源范围");
  const changed = store.deactivateMapping(mappingId);
  invalidateConfirmation(task); if (task.plan) { task.status = "awaiting_confirmation"; task.workflowStage = "preview"; } await store.save(task);
  return { changed };
});
app.get("/api/tasks/:id/runs/:version", async (req) => {
  const { id, version } = req.params as { id: string; version: string };
  const run = (await store.get(id)).runs?.find((item) => item.version === Number(version));
  if (!run) throw new Error("运行版本不存在");
  return run;
});
app.get("/api/tasks/:id/runs/:version/artifacts/:name", async (req, reply) => {
  const { id, version, name } = req.params as { id: string; version: string; name: string };
  const run = (await store.get(id)).runs?.find((item) => item.version === Number(version));
  const safe = basename(name);
  if (!run || !["completed", "completed_with_exceptions"].includes(run.status)) return reply.code(404).send({ error: "该运行产物不存在" });
  const outputRoot = resolve(join(store.taskDir(id), "outputs")), runRoot = resolve(run.outputDir);
  if (!runRoot.startsWith(`${outputRoot}${sep}`)) return reply.code(403).send({ error: "运行目录越权" });
  const artifacts = run.artifacts ?? await readdir(run.outputDir);
  if (!artifacts.includes(safe)) return reply.code(404).send({ error: "该运行产物不存在" });
  return reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`).send(createReadStream(join(run.outputDir, safe)));
});
app.post("/api/tasks/:id/runs", async (req, reply) => {
  const task = await store.get((req.params as any).id);
  return reply.redirect(`/api/tasks/${task.id}/${task.generic ? "v2/" : ""}execute`, 307);
});
app.get("/api/tasks/:id/events", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  await store.get(id);
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  let lastRevision = -1, busy = false;
  const tick = async () => {
    if (busy || reply.raw.destroyed) return;
    busy = true;
    try { const task = await store.get(id); if ((task.revision ?? 0) !== lastRevision) { lastRevision = task.revision ?? 0; reply.raw.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`); } }
    catch (error) { reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`); reply.raw.end(); }
    finally { busy = false; }
  };
  await tick();
  const timer = setInterval(() => void tick(), 1000);
  req.raw.on("close", () => clearInterval(timer));
});
app.delete("/api/tasks/:id", async (req, reply) => { const task = await store.get((req.params as any).id); if (task.status === "running") return reply.code(409).send({ error: "运行中任务不得删除" }); await store.delete(task.id); return { deleted: true }; });

app.post("/api/tasks/:id/files", async (req) => {
  const id = (req.params as any).id, task = await store.get(id), uploadDir = join(store.taskDir(id), "uploads"); await mkdir(uploadDir, { recursive: true });
  const uploaded = [];
  for await (const part of req.files()) {
    const name = basename(part.filename).replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const artifactId = `artifact-${crypto.randomUUID()}`, storedPath = join(uploadDir, `${artifactId}-${name}`);
    await writeFile(storedPath, await part.toBuffer()); const artifact = await analyzeWorkbook(storedPath, artifactId); artifact.fileName = name; task.files.push(artifact); uploaded.push(artifact);
  }
  await store.save(task); return uploaded;
});

app.post("/api/tasks/:id/analyze", async (req) => {
  const task = await store.get((req.params as any).id); if (!task.files.length) throw new Error("请先上传文件");
  invalidateConfirmation(task); task.status = "analyzed"; task.workflowStage = "analyze";
  task.progress = { phase: "analyzing", completed: 0, total: task.files.length, message: "分析工作簿结构" }; await store.save(task);
  task.files = await Promise.all(task.files.map(async (f) => { const analyzed = await analyzeWorkbook(f.path, f.id); analyzed.fileName = f.fileName; return analyzed; }));
  const stalePatches = (task.patches ?? []).filter((patch) => task.files.find((file) => file.id === patch.artifactId)?.sha256 !== patch.inputHash);
  task.archivedPatches = [...(task.archivedPatches ?? []), ...stalePatches]; task.patches = (task.patches ?? []).filter((patch) => !stalePatches.includes(patch));
  delete task.manifest; if (task.generic) delete task.generic.result;
  task.progress = { phase: "idle", completed: task.files.length, total: task.files.length, message: "结构分析完成" };
  task.workflowStage = "retrieve_rules"; await store.save(task); return task;
});

app.post("/api/tasks/:id/plan", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any;
  try { task.plan = await buildPlan(task, String(body.instruction ?? ""), Boolean(body.useModel), body.provider); }
  catch (error) { task.clarificationQuestions = [(error as Error).message]; task.workflowStage = "clarify"; task.status = "awaiting_clarification"; await store.save(task); throw error; }
  delete task.generic;
  invalidateConfirmation(task); task.clarificationQuestions = []; task.workflowStage = "preview";
  task.status = "awaiting_confirmation"; await store.save(task); return task.plan;
});

app.put("/api/tasks/:id/plan", async (req) => {
  const task = await store.get((req.params as any).id); task.plan = validatePlan(req.body); delete task.generic; invalidateConfirmation(task); task.workflowStage = "preview"; task.status = "awaiting_confirmation"; await store.save(task); return task.plan;
});

async function loadVersionedConfig(kind: "rules" | "templates", id: string, version: number): Promise<unknown> {
  StableIdSchema.parse(id);
  return JSON.parse(await readFile(join(configRoot, kind, `${id}.v${version}.json`), "utf8"));
}
function assertPublishedEffective(rule: ReturnType<typeof RuleSetVersionSchema.parse>): void {
  if (rule.status !== "published") throw new Error("规则尚未发布");
  if (rule.effectiveFrom && Date.parse(rule.effectiveFrom) > Date.now()) throw new Error(`规则将在 ${rule.effectiveFrom} 生效，不能提前替代当前有效版本`);
}

app.put("/api/tasks/:id/v2/plan", async (req) => {
  const task = await store.get((req.params as any).id), plan = (req.body as any)?.version === 3 ? ProcessPlanV3Schema.parse(req.body) : ProcessPlanV2Schema.parse(req.body);
  if (plan.inputs.some((input) => !task.files.some((file) => file.id === input.artifactId && file.sheets.some((sheet) => sheet.id === input.sheetId)))) throw new Error("计划引用了不属于当前任务的 artifact 或工作表");
  const rules = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", plan.rules.id, plan.rules.version));
  const template = TargetTemplateVersionSchema.parse(await loadVersionedConfig("templates", plan.targetTemplate.id, plan.targetTemplate.version));
  assertPublishedEffective(rules); if (JSON.stringify(rules.steps) !== JSON.stringify(plan.steps)) throw new Error("计划步骤与已发布规则版本不一致");
  task.generic = { plan, rules, template }; delete task.plan; delete task.manifest; invalidateConfirmation(task);
  task.workflowStage = "preview"; task.status = "awaiting_confirmation"; await store.save(task); return task.generic;
});

app.post("/api/tasks/:id/v2/suggest", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any, instruction = String(body.instruction ?? "");
  const templateId = StableIdSchema.parse(body.templateId);
  let rules: ReturnType<typeof RuleSetVersionSchema.parse>;
  if (body.ruleId) rules = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", StableIdSchema.parse(body.ruleId), Number(body.ruleVersion)));
  else {
    const identities = [...new Set(task.files.map((file) => sourceIdentityFor(task, file)?.id).filter((id): id is string => Boolean(id)))];
    const identity = StableIdSchema.parse(body.sourceIdentity ?? (identities.length === 1 ? identities[0] : ""));
    rules = await resolvePublishedRule(identity);
  }
  const template = TargetTemplateVersionSchema.parse(await loadVersionedConfig("templates", templateId, Number(body.templateVersion)));
  assertPublishedEffective(rules);
  task.conversation ??= []; task.conversation.push(message("user", instruction));
  try {
    const history = task.conversation.filter((item) => item.role === "user").slice(0, -1).slice(-5).map((item) => item.content), previousDraft = task.generic?.plan;
    const { privateTerms, ...profile } = await profileArtifactsForModel(task.files, [instruction, ...history, JSON.stringify(previousDraft ?? {})].join("\n"));
    const suggestion = await suggestPlanV2Detailed({ instruction, history, previousDraft, artifacts: task.files.map((file) => ({ id: file.id, sheets: file.sheets.map((sheet) => ({ id: sheet.id, headerRow: sheet.headerRow, columns: sheet.columns.map((column) => ({ index: column.index, header: column.header, inferredTypes: column.inferredTypes })) })) })), rules, template, profile, privateTerms }, body.provider ?? "deepseek");
    const bindings = await bindWorkbookInputsV2(suggestion.plan, task.files); preflightPlanV2(suggestion.plan, bindings, template);
    task.generic = { plan: suggestion.plan, rules, template }; delete task.plan; delete task.manifest; invalidateConfirmation(task);
    task.clarificationQuestions = []; task.workflowStage = "preview"; task.status = "awaiting_confirmation";
    task.conversation.push(message("assistant", "V2 映射与计划经本地校验，等待预览确认。", { ...suggestion.call, repairRounds: suggestion.repairRounds, requestSummaryHash: promptHash({ instruction: "redacted", headers: contextHeaders(task) }), stages: { transport: "passed", structure: "passed", semantics: "passed" }, status: "success" })); await store.save(task); return task.generic;
  } catch (error) {
    task.clarificationQuestions = [(error as Error).message]; task.workflowStage = "clarify"; task.status = "awaiting_clarification";
    task.conversation.push(message("assistant", `需要澄清：${(error as Error).message}`)); await store.save(task); throw error;
  }
});

app.post("/api/tasks/:id/v3/propose", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any, instruction = String(body.instruction ?? "");
  const templateId = StableIdSchema.parse(body.templateId), template = TargetTemplateVersionSchema.parse(await loadVersionedConfig("templates", templateId, Number(body.templateVersion)));
  const ruleRef = { id: `draft.${task.id}`, version: (task.planRevision ?? 0) + 1 };
  task.conversation ??= []; task.conversation.push(message("user", instruction));
  try {
    const history = task.conversation.filter((item) => item.role === "user").slice(0, -1).slice(-5).map((item) => item.content), previousDraft = task.generic?.plan;
    const { privateTerms, ...profile } = await profileArtifactsForModel(task.files, [instruction, ...history, JSON.stringify(previousDraft ?? {})].join("\n"));
    const suggestion = await suggestRuleDraftV3Detailed({ instruction, history, previousDraft, artifacts: task.files.map((file) => ({ id: file.id, sheets: file.sheets.map((sheet) => ({ id: sheet.id, headerRow: sheet.headerRow, columns: sheet.columns.map((column) => ({ index: column.index, header: column.header, inferredTypes: column.inferredTypes })) })) })), template, ruleRef, profile, privateTerms }, body.provider ?? "deepseek");
    task.ruleDraft = suggestion.draft;
    if (suggestion.draft.status !== "proposed" || !suggestion.draft.plan) {
      delete task.generic; invalidateConfirmation(task); task.clarificationQuestions = suggestion.draft.clarifications.length ? suggestion.draft.clarifications : ["当前请求不在受限规则能力范围内"];
      task.workflowStage = "clarify"; task.status = "awaiting_clarification";
      task.conversation.push(message("assistant", suggestion.draft.status === "unsupported" ? "当前请求无法由受限规则安全执行。" : "需要补充业务参数后才能生成规则草案。", suggestion.call ? { ...suggestion.call, status: "success" } : undefined));
      await store.save(task); return suggestion.draft;
    }
    const plan = suggestion.draft.plan, call = suggestion.call;
    const rules = RuleSetVersionSchema.parse({ id: ruleRef.id, version: ruleRef.version, name: instruction.slice(0, 40) || "新规则草案", status: "validated", aliases: {}, steps: plan.steps, scope: { kind: "one_time" }, validatorVersion: "v3.1", provenance: call ? { kind: "model", provider: call.provider, model: call.model, promptHash: promptHash({ instruction: privateTerms?.length ? "redacted" : instruction, ruleRef, template: plan.targetTemplate }) } : { kind: "manual", editedBy: "local-validator" } });
    const bindings = await bindWorkbookInputsV2(plan, task.files);
    preflightPlanV2(plan, bindings, template);
    task.generic = { plan, rules, template }; delete task.plan; delete task.manifest; invalidateConfirmation(task);
    task.clarificationQuestions = []; task.workflowStage = "preview"; task.status = "awaiting_confirmation";
    task.conversation.push(message("assistant", `新规则草案通过本地结构与逐项语义校验（${suggestion.draft.requirements.length} 项），请预演并确认本次使用。`, call ? { ...call, repairRounds: suggestion.repairRounds, requestSummaryHash: promptHash({ instruction: "redacted", headers: contextHeaders(task) }), stages: { transport: "passed", structure: "passed", semantics: "passed" }, status: "success" } : undefined));
    await store.save(task); return task.generic;
  } catch (error) {
    task.clarificationQuestions = [(error as Error).message]; task.workflowStage = "clarify"; task.status = "awaiting_clarification";
    task.conversation.push(message("assistant", `草案需澄清：${(error as Error).message}`)); await store.save(task); throw error;
  }
});

app.post("/api/tasks/:id/v2/preview", async (req) => {
  const task = await store.get((req.params as any).id); if (!task.generic) throw new Error("任务尚无 V2 计划");
  await verifyTaskInputs(task);
  const result = await executeWorkbookPlanV2({ ...task.generic, artifacts: task.files, allowDraft: ["draft", "validated"].includes(task.generic.rules.status) });
  const prepared = batchTemplatedOutputs({ outputs: result.outputs, template: task.generic.template });
  const columns = task.generic.template.sheets[0].columns;
  const primary = prepared.outputs[task.generic.template.sheets[0].sheetId];
  task.previewHash = planBindingHash(task.generic.plan, task.files, task.patches, { rules: task.generic.rules, template: task.generic.template }); task.workflowStage = "confirm"; await store.save(task);
  return { headers: columns.map((column) => column.header), rows: primary.rows.slice(0, 20).map((row) => ({ sourceRow: row.lineage[0]?.sourceRow ?? 0, cells: columns.map((column) => String(row.values[column.columnId] ?? column.defaultValue ?? "")) })), sheets: task.generic.template.sheets.map((sheet) => ({ sheetId: sheet.sheetId, name: sheet.name, headers: sheet.columns.map((column) => column.header), rows: prepared.outputs[sheet.sheetId].rows.slice(0, 20).map((row) => sheet.columns.map((column) => String(row.values[column.columnId] ?? column.defaultValue ?? ""))), outputRows: prepared.outputs[sheet.sheetId].rows.length })), batchCount: prepared.batches.length, exceptions: [...result.exceptions, ...prepared.exceptions].slice(0, 20), exceptionCount: result.exceptions.length + prepared.exceptions.length, stages: result.stages, reconciliation: { ...result.reconciliation, isolatedRows: result.reconciliation.isolatedRows + prepared.exceptions.length, outputRows: prepared.outputRows } };
});

app.post("/api/tasks/:id/v2/confirm", async (req) => {
  const task = await store.get((req.params as any).id); if (!task.generic) throw new Error("任务尚无 V2 计划");
  await verifyTaskInputs(task);
  if (!task.previewHash || task.previewHash !== planBindingHash(task.generic.plan, task.files, task.patches, { rules: task.generic.rules, template: task.generic.template })) throw new Error("请先完成与当前规则和输入一致的完整预演");
  if (task.generic.rules.status === "draft") task.generic.rules = transitionRuleStatus(transitionRuleStatus(task.generic.rules, "validated", "local-validator"), "confirmed", String((req.body as any)?.confirmedBy ?? "Web用户"));
  else if (task.generic.rules.status === "validated") task.generic.rules = transitionRuleStatus(task.generic.rules, "confirmed", String((req.body as any)?.confirmedBy ?? "Web用户"));
  task.planRevision = (task.planRevision ?? 0) + 1;
  task.confirmation = { planRevision: task.planRevision, bindingHash: planBindingHash(task.generic.plan, task.files, task.patches, { rules: task.generic.rules, template: task.generic.template }), confirmedBy: String((req.body as any)?.confirmedBy ?? "Web用户"), confirmedAt: new Date().toISOString() };
  task.status = "ready"; task.workflowStage = "execute"; await store.save(task); return task;
});

app.post("/api/tasks/:id/v2/execute", async (req, reply) => {
  const task = await store.get((req.params as any).id);
  if (!task.generic) return reply.code(409).send({ error: "任务尚无通用计划" });
  const key = req.headers["idempotency-key"];
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) return reply.code(400).send({ error: "幂等键格式无效" });
  const previousRun = key ? task.runs?.find((item) => item.idempotencyKey === key) : undefined;
  if (previousRun) {
    if (previousRun.bindingHash !== task.confirmation?.bindingHash) return reply.code(409).send({ error: "幂等键已绑定旧计划，请使用新键" });
    return reply.code(previousRun.status === "running" ? 202 : 200).send(task);
  }
  if (["completed", "completed_with_exceptions"].includes(task.status)) return task;
  if (task.status === "running") return reply.code(202).send(task);
  assertConfirmationCurrent(task);
  await verifyTaskInputs(task);
  const version = (task.runs?.at(-1)?.version ?? 0) + 1;
  const finalDir = join(store.taskDir(task.id), "outputs", `run-${version}`), stagingDir = `${finalDir}.staging`;
  const run: NonNullable<typeof task.runs>[number] = { version, status: "running", outputDir: stagingDir, startedAt: new Date().toISOString(), planRevision: task.planRevision ?? 0, patchIds: [], bindingHash: task.confirmation?.bindingHash, idempotencyKey: key, snapshot: { plan: structuredClone(task.generic.plan), inputs: task.files.map((file) => ({ artifactId: file.id, sha256: file.sha256 })), rules: structuredClone(task.generic.rules), template: structuredClone(task.generic.template), patches: [] } };
  task.runs ??= []; task.runs.push(run); task.status = "running"; task.cancelRequested = false;
  task.progress = { phase: "queued", completed: 0, total: 3, message: "等待本机执行队列" };
  try { await store.save(task); } catch (error) {
    if (error instanceof TaskRevisionConflictError) { const current = await store.get(task.id); if (current.status === "running") return reply.code(202).send(current); }
    throw error;
  }
  const job = executionQueue.then(async () => {
    try {
      await mkdir(stagingDir, { recursive: true });
      await waitForExecutionSlot();
      task.progress = { phase: "executing", completed: 1, total: 3, message: "执行通用计划" }; await saveRunState(task);
      const snapshot = run.snapshot!;
      const result = await executeWorkbookPlanV2({ plan: snapshot.plan as ProcessPlanV2 | ProcessPlanV3, rules: snapshot.rules!, template: snapshot.template!, artifacts: task.files });
      const prepared = batchTemplatedOutputs({ outputs: result.outputs, template: snapshot.template! });
      const outputFiles: Array<{ fileName: string; sha256: string; outputRows: number }> = [];
      for (let index = 0; index < prepared.batches.length; index++) {
        task.progress = { phase: "writing", completed: 2 + index, total: 2 + prepared.batches.length, message: `写出并复读校验第 ${index + 1}/${prepared.batches.length} 批` }; await saveRunState(task);
        const fileName = prepared.batches.length === 1 ? `目标输出.${snapshot.template!.format}` : `目标输出-第${index + 1}批.${snapshot.template!.format}`;
        const outputPath = join(stagingDir, fileName);
        const written = await writeTemplatedWorkbookV3({ outputs: prepared.batches[index], template: snapshot.template!, path: outputPath });
        if (written.exceptions.length) throw new Error("分批写出与预演校验结果不一致");
        outputFiles.push({ fileName, sha256: await sha256File(outputPath), outputRows: written.outputRows });
      }
      const exceptions = [...result.exceptions, ...prepared.exceptions];
      if (exceptions.length) await writeExceptions(exceptions, join(stagingDir, "异常日志.xlsx"));
      const output = { outputFile: outputFiles[0].fileName, outputFiles, outputRows: prepared.outputRows, stages: result.stages, reconciliation: { ...result.reconciliation, isolatedRows: result.reconciliation.isolatedRows + prepared.exceptions.length, outputRows: prepared.outputRows }, exceptions: exceptions.length, sha256: outputFiles[0].sha256 };
      await writeFile(join(stagingDir, "审计清单.json"), `${JSON.stringify({ taskId: task.id, plan: snapshot.plan, rule: snapshot.rules, template: snapshot.template, inputs: snapshot.inputs, output, confirmedAt: task.confirmation?.confirmedAt, confirmedBy: task.confirmation?.confirmedBy }, null, 2)}\n`);
      await verifyTaskInputs(task); await runCheckpoint(task); await rename(stagingDir, finalDir);
      task.generic!.result = output; task.currentOutputDir = finalDir; run.outputDir = finalDir; run.artifacts = await readdir(finalDir);
      task.status = exceptions.length ? "completed_with_exceptions" : "completed"; run.status = task.status; run.completedAt = new Date().toISOString();
      task.workflowStage = "explain"; task.progress = { phase: "completed", completed: 2 + prepared.batches.length, total: 2 + prepared.batches.length, message: "通用计划执行完成" };
      await saveRunState(task);
    } catch (error) {
      const outcome = await finishRunError(task, version, error);
      await rm(stagingDir, { recursive: true, force: true });
      if (outcome.status !== "cancelled") throw error;
    }
  });
  executionQueue = job.then(() => undefined, () => undefined);
  await job; return store.get(task.id);
});

app.post("/api/tasks/:id/messages", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any;
  try { task.plan = await buildPlan(task, String(body.content ?? ""), Boolean(body.useModel), body.provider); invalidateConfirmation(task); task.clarificationQuestions = []; task.workflowStage = "preview"; task.status = "awaiting_confirmation"; await store.save(task); }
  catch (error) { task.clarificationQuestions = [(error as Error).message]; task.workflowStage = "clarify"; task.status = "awaiting_clarification"; task.conversation?.push(message("assistant", `需要澄清：${(error as Error).message}`)); await store.save(task); }
  return task;
});

app.post("/api/tasks/:id/mapping-suggestions", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any, sheet = task.files.flatMap((file) => file.sheets).find((candidate) => candidate.id === body.sheetId);
  if (!sheet) throw new Error("工作表不属于当前任务");
  const instruction = String(body.instruction ?? "识别字段映射"), { privateTerms } = await profileArtifactsForModel(task.files, instruction);
  const result = await suggestMappings({ instruction, headers: sheet.headers, inferredTypes: sheet.inferredTypes, privateTerms, provider: body.provider });
  task.mappingSuggestions = result.advice.mappings; task.clarificationQuestions = result.advice.clarificationQuestions; task.workflowStage = result.advice.clarificationQuestions.length ? "clarify" : "plan"; task.conversation?.push(message("assistant", `字段映射建议已生成：${result.advice.mappings.length} 项；置信度仅供待确认排序。`, { ...result.call, repairRounds: 0, requestSummaryHash: promptHash({ instruction: "redacted", headers: sheet.headers }), stages: { transport: "passed", structure: "passed", semantics: "not_run" }, status: "success" })); await store.save(task); return result.advice;
});

app.post("/api/tasks/:id/preview", async (req) => {
  const task = await store.get((req.params as any).id); if (!task.plan) throw new Error("任务尚无计划"); await verifyTaskInputs(task); task.progress = { phase: "previewing", completed: 0, total: 1, message: "本地预览计算" }; await store.save(task);
    task.mappingSnapshot = sourceAliases(task);
    const previewPlan = validatePlan({ ...task.plan, allowStaleBalance: true }), result = await executePlan(previewPlan, await sourcePatches(task), task.mappingSnapshot); task.previewHash = planBindingHash(task.plan, task.files, task.patches, { aliases: task.mappingSnapshot }); task.workflowStage = "confirm"; await store.save(task);
  task.progress = { phase: "idle", completed: 1, total: 1, message: "预览完成" }; await store.save(task);
  return { headers: result.headers, rows: result.rows.slice(0, 20), exceptions: result.exceptions.slice(0, 20), summary: result.summary, stages: result.stages, reconciliation: { inputRows: result.sourceCount, outputRows: result.rows.length, isolatedRows: result.exceptions.filter((error) => error.severity === "error").length }, requiresStaleBalanceConfirmation: task.plan.operation === "annual_leave_settlement" && result.summary.balanceAsOfNumeric !== undefined };
});

app.post("/api/tasks/:id/confirm", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any;
  if (!task.plan) throw new Error("任务尚无计划");
  await verifyTaskInputs(task);
  if (!task.previewHash || task.previewHash !== planBindingHash(task.plan, task.files, task.patches, { aliases: task.mappingSnapshot })) throw new Error("请先完成与当前输入和补丁一致的完整预演");
  task.plan = validatePlan({ ...task.plan, allowStaleBalance: Boolean(body.allowStaleBalance), confirmedBy: String(body.confirmedBy ?? "Web用户") });
  task.planRevision = (task.planRevision ?? 0) + 1; task.confirmation = { planRevision: task.planRevision, bindingHash: planBindingHash(task.plan, task.files, task.patches, { aliases: task.mappingSnapshot }), confirmedBy: task.plan.confirmedBy ?? "Web用户", confirmedAt: new Date().toISOString() }; task.workflowStage = "execute";
  task.status = "ready"; await store.save(task); return task;
});

app.post("/api/tasks/:id/execute", async (req, reply) => {
  const task = await store.get((req.params as any).id); if (!task.plan) return reply.code(409).send({ error: "任务尚无计划" });
  const key = req.headers["idempotency-key"];
  if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))) return reply.code(400).send({ error: "幂等键格式无效" });
  const previousRun = key ? task.runs?.find((item) => item.idempotencyKey === key) : undefined;
  if (previousRun) {
    if (previousRun.bindingHash !== task.confirmation?.bindingHash) return reply.code(409).send({ error: "幂等键已绑定旧计划，请使用新键" });
    return reply.code(previousRun.status === "running" ? 202 : 200).send(task);
  }
  if (["completed", "completed_with_exceptions"].includes(task.status)) return task;
  if (task.status === "running") return reply.code(202).send(task);
  assertConfirmationCurrent(task);
  await verifyTaskInputs(task);
  const version = (task.runs?.at(-1)?.version ?? 0) + 1;
  const finalDir = join(store.taskDir(task.id), "outputs", `run-${version}`), stagingDir = `${finalDir}.staging`;
  const run: NonNullable<typeof task.runs>[number] = { version, status: "running", outputDir: stagingDir, startedAt: new Date().toISOString(), planRevision: task.planRevision ?? 0, patchIds: (task.patches ?? []).map((patch) => patch.id), bindingHash: task.confirmation?.bindingHash, idempotencyKey: key, snapshot: { plan: structuredClone(task.plan), inputs: task.files.map((file) => ({ artifactId: file.id, sha256: file.sha256 })), patches: structuredClone(task.patches ?? []), mappingSnapshot: structuredClone(task.mappingSnapshot ?? {}) } };
  task.runs ??= []; task.runs.push(run); task.status = "running"; task.cancelRequested = false;
  task.progress = { phase: "queued", completed: 0, total: 3, message: "等待本机执行队列" };
  try { await store.save(task); } catch (error) {
    if (error instanceof TaskRevisionConflictError) { const current = await store.get(task.id); if (current.status === "running") return reply.code(202).send(current); }
    throw error;
  }
  const job = executionQueue.then(async () => {
    try {
      await mkdir(stagingDir, { recursive: true });
      await waitForExecutionSlot();
      task.progress = { phase: "executing", completed: 1, total: 3, message: "执行确定性计算" }; await saveRunState(task);
      const snapshot = run.snapshot!;
      const result = await executePlan(snapshot.plan as ProcessPlan, await sourcePatches({ ...task, patches: snapshot.patches }), snapshot.mappingSnapshot);
      task.progress = { phase: "writing", completed: 2, total: 3, message: "写出并复读校验" }; await saveRunState(task);
      const manifest = await writeDeliverables({ taskId: task.id, outputDir: stagingDir, result, plan: snapshot.plan as ProcessPlan, confirmedBy: (snapshot.plan as ProcessPlan).confirmedBy });
      await verifyTaskInputs(task); await runCheckpoint(task); await rename(stagingDir, finalDir);
      task.manifest = manifest; task.currentOutputDir = finalDir; run.outputDir = finalDir; run.artifacts = await readdir(finalDir);
      task.status = manifest.status; run.status = manifest.status; run.completedAt = new Date().toISOString();
      task.workflowStage = "explain"; task.progress = { phase: "completed", completed: 3, total: 3, message: "执行与校验完成" };
      task.conversation?.push(message("assistant", `执行完成：输入 ${manifest.reconciliation.inputRows}，输出 ${manifest.reconciliation.outputRows}，异常 ${manifest.exceptions.errors}。`));
      await saveRunState(task);
    } catch (error) {
      const outcome = await finishRunError(task, version, error);
      await rm(stagingDir, { recursive: true, force: true });
      if (outcome.status !== "cancelled") throw error;
    }
  });
  executionQueue = job.then(() => undefined, () => undefined);
  await job; return store.get(task.id);
});

app.post("/api/tasks/:id/patches", async (req) => {
  const task = await store.get((req.params as any).id), body = req.body as any;
  if (task.generic) throw new Error("通用任务源补丁尚未开放，请修改源文件后重新上传");
  const artifact = task.files.find((file) => file.id === body.artifactId), sheet = artifact?.sheets.find((item) => item.id === body.sheetId);
  const column = sheet?.columns.find((item) => item.id === body.columnId);
  if (!body.exceptionId || !["correct", "exclude"].includes(body.action) || !Number.isInteger(body.sourceRow) || body.sourceRow < 1 || !artifact || !sheet || (body.action === "correct" && (!column || body.value === undefined || typeof body.value === "object"))) throw new Error("源数据补丁参数无效：需指定任务内文件、工作表、源行及源列");
  if (await sha256File(artifact.path) !== artifact.sha256) throw new Error("源文件内容已变化，请重新上传");
  const patch = { id: crypto.randomUUID(), exceptionId: String(body.exceptionId), action: body.action as "correct" | "exclude", artifactId: artifact.id, sheetId: sheet.id, sourceRow: body.sourceRow as number, columnId: column?.id, inputHash: artifact.sha256, value: body.action === "correct" ? body.value as string | number | boolean | null : undefined, createdAt: new Date().toISOString(), createdBy: String(body.createdBy ?? "Web用户") };
  task.patches ??= []; task.patches.push(patch); invalidateConfirmation(task); task.status = "awaiting_confirmation"; task.workflowStage = "preview"; await store.save(task); return patch;
});

app.post("/api/tasks/:id/rerun", async (req, reply) => {
  const task = await store.get((req.params as any).id); if (!task.plan) return reply.code(409).send({ error: "任务尚无计划" }); assertConfirmationCurrent(task); task.status = "ready"; await store.save(task);
  return reply.redirect(`/api/tasks/${task.id}/execute`, 307);
});

app.get("/api/tasks/:id/artifacts/:name", async (req, reply) => {
  const { id, name } = req.params as any, task = await store.get(id); const safe = basename(name), root = resolve(task.currentOutputDir ?? join(store.taskDir(id), "outputs")), path = resolve(root, safe);
  if (!path.startsWith(`${root}${sep}`)) return reply.code(403).send({ error: "下载路径越权" });
  return reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`).send(createReadStream(path));
});

async function listConfigs(kind: "rules" | "templates") { const directory = join(configRoot, kind); await mkdir(directory, { recursive: true }); return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")))); }
async function writeNewRule(rule: unknown) {
  const value = RuleSetVersionSchema.parse(rule), directory = join(configRoot, "rules"); await mkdir(directory, { recursive: true });
  const path = join(directory, `${value.id}.v${value.version}.json`);
  try { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("规则版本已存在，禁止覆盖"); throw error; }
  return value;
}
async function updateRuleStatus(rule: unknown) {
  const value = RuleSetVersionSchema.parse(rule), path = join(configRoot, "rules", `${value.id}.v${value.version}.json`), current = RuleSetVersionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const immutable = (item: typeof value) => { const { status: _status, confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, scope: _scope, effectiveFrom: _effectiveFrom, ...content } = item; void _status; void _confirmedBy; void _confirmedAt; void _scope; void _effectiveFrom; return content; };
  if (JSON.stringify(immutable(current)) !== JSON.stringify(immutable(value))) throw new Error("状态转换不得改写规则内容；请创建新修订");
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, path); return value;
}
async function latestRule(id: string) {
  StableIdSchema.parse(id); const rules = (await listConfigs("rules")).map((value) => RuleSetVersionSchema.parse(value)).filter((rule) => rule.id === id).sort((a, b) => b.version - a.version);
  if (!rules.length) throw new Error("规则不存在"); return rules[0];
}
async function resolvePublishedRule(sourceIdentity: string, at = new Date()) {
  const matches = (await listConfigs("rules")).map((value) => RuleSetVersionSchema.parse(value)).filter((rule) => rule.status === "published" && rule.scope.kind === "source" && rule.scope.sourceIdentity === sourceIdentity && (!rule.effectiveFrom || Date.parse(rule.effectiveFrom) <= at.getTime())).sort((a, b) => b.version - a.version);
  if (!matches.length) throw new Error(`来源 ${sourceIdentity} 没有当前生效的已发布规则`); return matches[0];
}
app.get("/api/rules", async () => (await listConfigs("rules")).map((value) => RuleSetVersionSchema.parse(value)));
app.get("/api/rules/resolve", async (req) => { const query = req.query as any; return resolvePublishedRule(StableIdSchema.parse(query.sourceIdentity), query.at ? new Date(String(query.at)) : new Date()); });
app.get("/api/rules/:id/diff", async (req) => {
  const { id } = req.params as { id: string }, { from, to } = req.query as { from?: string; to?: string };
  const fromVersion = Number(from), toVersion = Number(to);
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || !Number.isInteger(toVersion) || toVersion < 1) throw new Error("规则差异必须指定有效的 from 和 to 版本");
  return diffRuleRevisions(RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, fromVersion)), RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, toVersion)));
});
app.get("/api/templates", async () => listConfigs("templates"));
app.post("/api/rules/:id/revisions", async (req) => {
  const id = StableIdSchema.parse((req.params as any).id), body = req.body as any;
  if (body.patch) {
    const current = await latestRule(id), patch = RulePatchSchema.parse(body.patch);
    return writeNewRule(applyRulePatch(current, patch, String(body.editedBy ?? "Web用户")));
  }
  const proposed = RuleSetVersionSchema.parse({ ...body.rule, id, version: 1, status: "draft", confirmedBy: undefined, confirmedAt: undefined, effectiveFrom: undefined });
  return writeNewRule(proposed);
});
app.post("/api/rules/:id/revisions/propose-patch", async (req) => {
  const id = StableIdSchema.parse((req.params as any).id), body = req.body as any, current = await latestRule(id);
  const suggestion = await suggestRulePatchDetailed({ instruction: String(body.instruction ?? ""), current, privateTerms: Array.isArray(body.privateTerms) ? body.privateTerms.map(String) : undefined, providerId: body.provider ?? "deepseek" });
  if (suggestion.status === "clarification_required") return suggestion;
  return { status: "proposed", rule: await writeNewRule(applyRulePatch(current, suggestion.patch, String(body.editedBy ?? "Web用户"))), patch: suggestion.patch, modelCall: { ...suggestion.call, repairRounds: suggestion.repairRounds, requestSummaryHash: promptHash({ instruction: "redacted", rule: `${id}@${current.version}` }) } };
});
app.post("/api/rules/:id/revisions/:version/validate", async (req) => {
  const { id, version } = req.params as { id: string; version: string }, current = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, Number(version)));
  return updateRuleStatus(transitionRuleStatus(current, "validated", "local-validator"));
});
app.post("/api/rules/:id/revisions/:version/confirm", async (req) => {
  const { id, version } = req.params as { id: string; version: string }, current = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, Number(version)));
  return updateRuleStatus(transitionRuleStatus(current, "confirmed", String((req.body as any)?.confirmedBy ?? "Web用户")));
});
app.post("/api/rules/:id/revisions/:version/publish", async (req) => {
  const { id, version } = req.params as { id: string; version: string }, body = req.body as any, current = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, Number(version)));
  const identity = StableIdSchema.parse(body.sourceIdentity), scoped = RuleSetVersionSchema.parse({ ...current, scope: { kind: "source", sourceIdentity: identity }, effectiveFrom: body.effectiveFrom });
  return updateRuleStatus(transitionRuleStatus(scoped, "published", String(body.publishedBy ?? "Web用户")));
});
app.post("/api/rules/:id/revisions/:version/supersede", async (req) => {
  const { id, version } = req.params as { id: string; version: string }, current = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, Number(version)));
  return updateRuleStatus(transitionRuleStatus(current, "superseded", String((req.body as any)?.supersededBy ?? "Web用户")));
});
app.post("/api/rules/:id/restore", async (req) => {
  const id = StableIdSchema.parse((req.params as any).id), body = req.body as any, current = await latestRule(id), history = RuleSetVersionSchema.parse(await loadVersionedConfig("rules", id, Number(body.sourceVersion)));
  if (Number(body.baseRevision) !== current.version) throw new RuleRevisionConflictError(Number(body.baseRevision), current.version);
  return writeNewRule(restoreRuleRevision(history, current, String(body.editedBy ?? "Web用户")));
});
app.put("/api/rules/:id", async (req) => {
  const requested = RuleSetVersionSchema.parse(req.body), id = StableIdSchema.parse((req.params as any).id); if (requested.id !== id) throw new Error("规则 ID 与路径不一致");
  let value = RuleSetVersionSchema.parse({ ...requested, status: "draft", scope: requested.scope.kind === "source" ? requested.scope : { kind: "source", sourceIdentity: "legacy:manual" }, confirmedBy: undefined, confirmedAt: undefined });
  value = transitionRuleStatus(value, "validated", "local-validator"); value = transitionRuleStatus(value, "confirmed", "兼容接口"); value = transitionRuleStatus(value, "published", "兼容接口");
  return writeNewRule(value);
});
app.put("/api/templates/:id", async (req) => { const value = TargetTemplateVersionSchema.parse(req.body), id = StableIdSchema.parse((req.params as any).id); if (value.id !== id) throw new Error("模板 ID 与路径不一致"); const directory = join(configRoot, "templates"); await mkdir(directory, { recursive: true }); const path = join(directory, `${id}.v${value.version}.json`); try { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("模板版本已存在，禁止覆盖"); throw error; } return value; });

app.get("/api/profiles", async () => Promise.all(["profiles/erp-overtime-to-hr.v1.json", "profiles/oa-leave-to-hr.v1.json", "profiles/annual-leave-settlement.v1.json"].map(async (p) => JSON.parse(await readFile(resolve(p), "utf8")))));
app.put("/api/profiles/:id", async (req) => { const body = req.body as any, id = StableIdSchema.parse((req.params as any).id); if (body.id !== id || !Number.isInteger(body.version) || body.version < 1 || !body.fieldMappings) throw new Error("来源配置 ID、版本或字段映射无效"); const path = resolve("profiles", `${id}.v${body.version}.json`); try { await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("来源配置版本已存在，禁止覆盖"); throw error; } return body; });

setInterval(() => void store.cleanup(Number(process.env.TASK_RETENTION_DAYS ?? 7)), 3_600_000).unref();
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 3210) });
