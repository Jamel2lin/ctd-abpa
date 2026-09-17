import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord, TaskStatus } from "@ctd-abpa/types";

export class TaskRevisionConflictError extends Error {
  constructor(id: string) { super(`任务 ${id} 已被其他请求修改，请刷新后重试`); }
}

export class TaskStore {
  private readonly db: DatabaseSync;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, "tasks.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS migration_audit (task_id TEXT PRIMARY KEY, legacy_sha256 TEXT NOT NULL, migrated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mapping_memory (id TEXT PRIMARY KEY, source_scope TEXT NOT NULL, standard_field TEXT NOT NULL, source_header TEXT NOT NULL, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL, active INTEGER NOT NULL, structure_fingerprint TEXT, evidence TEXT)");
    const columns = new Set((this.db.prepare("PRAGMA table_info(mapping_memory)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("structure_fingerprint")) this.db.exec("ALTER TABLE mapping_memory ADD COLUMN structure_fingerprint TEXT");
    if (!columns.has("evidence")) this.db.exec("ALTER TABLE mapping_memory ADD COLUMN evidence TEXT");
  }
  private dir(id: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("非法任务 ID"); return join(this.root, id); }
  private legacyPath(id: string): string { return join(this.dir(id), "task.json"); }

  async create(id = randomUUID()): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = { id, status: "draft", createdAt: now, updatedAt: now, files: [], workflowStage: "analyze", planRevision: 0, conversation: [], patches: [], runs: [], progress: { phase: "idle", completed: 0, total: 1, message: "等待上传" } };
    await mkdir(join(this.dir(id), "uploads"), { recursive: true });
    await this.save(task); return task;
  }
  async get(id: string): Promise<TaskRecord> {
    this.dir(id);
    const stored = this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id) as { json: string } | undefined;
    if (stored) return JSON.parse(stored.json) as TaskRecord;
    let source: Buffer, legacy = true;
    try { source = await readFile(join(this.dir(id), "task.current.json")); legacy = false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; source = await readFile(this.legacyPath(id)); }
    const task = JSON.parse(source.toString("utf8")) as TaskRecord;
    if (task.id !== id) throw new Error("旧任务 ID 与目录不一致");
    task.revision = 0;
    await this.save(task);
    let original = legacy ? source : undefined;
    if (!original) try { original = await readFile(this.legacyPath(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (original) this.db.prepare("INSERT OR IGNORE INTO migration_audit (task_id, legacy_sha256, migrated_at) VALUES (?, ?, ?)").run(id, createHash("sha256").update(original).digest("hex"), new Date().toISOString());
    return task;
  }
  async save(task: TaskRecord): Promise<void> {
    this.dir(task.id);
    const priorRevision = task.revision ?? 0, nextRevision = priorRevision + 1;
    const updatedAt = new Date().toISOString();
    const next = { ...task, revision: nextRevision, updatedAt };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT revision FROM tasks WHERE id = ?").get(task.id) as { revision: number } | undefined;
      if (existing && existing.revision !== priorRevision) throw new TaskRevisionConflictError(task.id);
      if (existing) this.db.prepare("UPDATE tasks SET revision = ?, json = ?, updated_at = ? WHERE id = ?").run(nextRevision, JSON.stringify(next), updatedAt, task.id);
      else if (priorRevision === 0) this.db.prepare("INSERT INTO tasks (id, revision, json, updated_at) VALUES (?, ?, ?, ?)").run(task.id, nextRevision, JSON.stringify(next), updatedAt);
      else throw new TaskRevisionConflictError(task.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    task.revision = nextRevision; task.updatedAt = updatedAt;
    await mkdir(this.dir(task.id), { recursive: true });
    const path = join(this.dir(task.id), "task.current.json"), temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(temp, path);
  }
  async transition(task: TaskRecord, next: TaskStatus): Promise<void> {
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      draft: ["analyzed", "failed"], analyzed: ["awaiting_clarification", "awaiting_confirmation", "ready", "failed"],
      awaiting_clarification: ["awaiting_clarification", "awaiting_confirmation", "ready", "failed"],
      awaiting_confirmation: ["awaiting_clarification", "ready", "failed"], ready: ["awaiting_clarification", "awaiting_confirmation", "running", "failed"],
      running: ["completed", "completed_with_exceptions", "failed", "cancelled"],
      completed: ["analyzed"], completed_with_exceptions: ["analyzed"], failed: ["analyzed", "ready"], cancelled: ["analyzed", "ready"],
    };
    if (!allowed[task.status].includes(next)) throw new Error(`非法任务状态转换: ${task.status} → ${next}`);
    task.status = next; await this.save(task);
  }
  async list(): Promise<TaskRecord[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory()) try { await this.get(entry.name); } catch { /* ignore incomplete legacy state */ }
    const rows = this.db.prepare("SELECT json FROM tasks ORDER BY updated_at DESC").all() as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as TaskRecord);
  }
  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000; let removed = 0;
    for (const task of await this.list()) if (task.status !== "running" && (await stat(this.dir(task.id))).mtimeMs < cutoff) { await rm(this.dir(task.id), { recursive: true }); this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id); removed++; }
    return removed;
  }
  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true });
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
  migrationAudit(): Array<{ taskId: string; legacySha256: string; migratedAt: string }> {
    return (this.db.prepare("SELECT task_id, legacy_sha256, migrated_at FROM migration_audit ORDER BY task_id").all() as Array<{ task_id: string; legacy_sha256: string; migrated_at: string }>).map((row) => ({ taskId: row.task_id, legacySha256: row.legacy_sha256, migratedAt: row.migrated_at }));
  }
  confirmMapping(args: { sourceScope: string; standardField: string; sourceHeader: string; confirmedBy: string; structureFingerprint?: string; evidence?: string }): { id: string; sourceScope: string; standardField: string; sourceHeader: string; confirmedBy: string; createdAt: string; active: boolean; structureFingerprint?: string; evidence?: string } {
    const id = randomUUID(), createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE mapping_memory SET active = 0 WHERE source_scope = ? AND standard_field = ?").run(args.sourceScope, args.standardField);
      this.db.prepare("INSERT INTO mapping_memory (id, source_scope, standard_field, source_header, confirmed_by, created_at, active, structure_fingerprint, evidence) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)").run(id, args.sourceScope, args.standardField, args.sourceHeader, args.confirmedBy, createdAt, args.structureFingerprint ?? null, args.evidence ?? null);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { id, ...args, createdAt, active: true };
  }
  mappings(sourceScope: string, structureFingerprint?: string): Array<{ id: string; standardField: string; sourceHeader: string; confirmedBy: string; createdAt: string; active: boolean; structureFingerprint?: string; evidence?: string; structureCompatible: boolean }> {
    return (this.db.prepare("SELECT id, standard_field, source_header, confirmed_by, created_at, active, structure_fingerprint, evidence FROM mapping_memory WHERE source_scope = ? ORDER BY created_at DESC").all(sourceScope) as Array<{ id: string; standard_field: string; source_header: string; confirmed_by: string; created_at: string; active: number; structure_fingerprint: string | null; evidence: string | null }>).map((row) => ({ id: row.id, standardField: row.standard_field, sourceHeader: row.source_header, confirmedBy: row.confirmed_by, createdAt: row.created_at, active: Boolean(row.active), structureFingerprint: row.structure_fingerprint ?? undefined, evidence: row.evidence ?? undefined, structureCompatible: structureFingerprint === undefined || row.structure_fingerprint === null || row.structure_fingerprint === structureFingerprint }));
  }
  deactivateMapping(id: string): boolean { return this.db.prepare("UPDATE mapping_memory SET active = 0 WHERE id = ?").run(id).changes > 0; }
  async recoverInterrupted(): Promise<number> {
    let recovered = 0;
    for (const task of await this.list()) if (task.status === "running") {
      const cancelled = task.cancelRequested === true;
      task.status = cancelled ? "cancelled" : "ready"; task.cancelRequested = false;
      task.error = cancelled ? "运行已取消" : "检测到进程中断，可安全重跑";
      task.progress = { phase: cancelled ? "cancelled" : "failed", completed: 0, total: 1, message: task.error };
      const run = task.runs?.at(-1);
      if (run?.status === "running") { run.status = cancelled ? "cancelled" : "failed"; run.completedAt = new Date().toISOString(); }
      await this.save(task); recovered++;
    }
    return recovered;
  }
  taskDir(id: string): string { return this.dir(id); }
}
