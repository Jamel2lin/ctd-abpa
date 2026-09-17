import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TaskStore } from "@ctd-abpa/core";

const root = resolve(process.env.TASK_STORAGE_DIR ?? ".tasks");
const store = new TaskStore(root);
const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
const legacy = new Map<string, string>();
for (const directory of directories) {
  try {
    const bytes = await readFile(join(root, directory.name, "task.json"));
    legacy.set(directory.name, createHash("sha256").update(bytes).digest("hex"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const tasks = await store.list(), audit = store.migrationAudit();
if (tasks.length < legacy.size) throw new Error(`迁移数量不足：旧任务 ${legacy.size}，SQLite ${tasks.length}`);
for (const [id, hash] of legacy) {
  if (!tasks.some((task) => task.id === id)) throw new Error(`旧任务未迁移：${id}`);
  if (audit.find((row) => row.taskId === id)?.legacySha256 !== hash) throw new Error(`旧任务哈希校验失败：${id}`);
}
console.log(JSON.stringify({ legacyTasks: legacy.size, sqliteTasks: tasks.length, verifiedHashes: legacy.size }, null, 2));
