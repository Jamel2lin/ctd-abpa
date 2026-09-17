import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore, assertConfirmationCurrent, invalidateConfirmation, planBindingHash, sourceIdentityScope } from "@ctd-abpa/core";
import type { ProcessPlan, SourceArtifact } from "@ctd-abpa/types";

const plan: ProcessPlan = { version: 1, operation: "oa_leave_to_hr", sources: { leave: "local" }, filters: [], allowStaleBalance: false };
const files: SourceArtifact[] = [{ id: "artifact-1", fileName: "a.csv", path: "local", sha256: "hash", kind: "leave", sheets: [{ id: "sheet-1", name: "Sheet1", rowCount: 1, columnCount: 1, headerRow: 1, headers: ["工号"], duplicateHeaders: [], emptyRows: [], inferredTypes: { 工号: ["string"] }, fingerprint: "fingerprint", columns: [{ id: "column-1", index: 0, header: "工号", inferredTypes: ["string"] }] }] }];

describe("任务持久化工作流", () => {
  it("确认绑定计划与输入，修改后立即失效", () => {
    const task = { id: "task", status: "ready" as const, createdAt: "", updatedAt: "", files, plan, planRevision: 1, confirmation: { planRevision: 1, bindingHash: planBindingHash(plan, files), confirmedBy: "tester", confirmedAt: "" } };
    expect(() => assertConfirmationCurrent(task)).not.toThrow(); invalidateConfirmation(task); expect(() => assertConfirmationCurrent(task)).toThrow(/尚未确认/);
  });

  it("进程重启后识别运行中任务并恢复为可重跑", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-store-"));
    try {
      const store = new TaskStore(directory), task = await store.create("interrupted"); task.status = "running"; task.plan = plan; await store.save(task);
      expect(await store.recoverInterrupted()).toBe(1); const recovered = await store.get(task.id); expect(recovered.status).toBe("ready"); expect(recovered.error).toMatch(/中断/);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("进程重启后保留已请求取消的运行记录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-store-cancel-"));
    try {
      const store = new TaskStore(directory), task = await store.create("cancelled-run");
      task.status = "running"; task.cancelRequested = true; task.runs = [{ version: 1, status: "running", outputDir: join(directory, task.id, "outputs", "run-1.staging"), startedAt: new Date().toISOString(), planRevision: 1, patchIds: [] }];
      await store.save(task);
      expect(await store.recoverInterrupted()).toBe(1);
      const recovered = await store.get(task.id);
      expect(recovered.status).toBe("cancelled"); expect(recovered.cancelRequested).toBe(false);
      expect(recovered.runs?.[0].status).toBe("cancelled");
    } finally { await rm(directory, { recursive: true }); }
  });

  it("同任务并发保存不因临时文件冲突失败", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-store-concurrent-"));
    try {
      const store = new TaskStore(directory), task = await store.create("concurrent");
      await expect(Promise.all(Array.from({ length: 8 }, () => store.save(task)))).resolves.toHaveLength(8);
      expect((await store.get(task.id)).id).toBe(task.id);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("字段映射按来源范围确认、替换和停用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-mappings-"));
    try {
      const store = new TaskStore(directory);
      const first = store.confirmMapping({ sourceScope: "a.csv/fingerprint", standardField: "employeeId", sourceHeader: "员工代号", confirmedBy: "tester" });
      expect(store.mappings("a.csv/fingerprint").filter((item) => item.active)).toHaveLength(1);
      store.confirmMapping({ sourceScope: "a.csv/fingerprint", standardField: "employeeId", sourceHeader: "人员代号", confirmedBy: "tester" });
      expect(store.mappings("a.csv/fingerprint").find((item) => item.id === first.id)?.active).toBe(false);
      expect(store.mappings("other.csv/fingerprint")).toEqual([]);
      const current = store.mappings("a.csv/fingerprint").find((item) => item.active)!;
      expect(store.deactivateMapping(current.id)).toBe(true);
      expect(store.mappings("a.csv/fingerprint").filter((item) => item.active)).toHaveLength(0);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("来源身份与结构指纹分开，文件改名不丢失来源内映射", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ctd-source-identity-"));
    try {
      const store = new TaskStore(directory);
      store.confirmMapping({ sourceScope: "oa:leave", structureFingerprint: "fp-v1", standardField: "employeeId", sourceHeader: "人员代号", confirmedBy: "tester", evidence: "用户确认" });
      expect(store.mappings("oa:leave", "fp-v1")[0]).toMatchObject({ sourceHeader: "人员代号", structureCompatible: true });
      expect(store.mappings("oa:leave", "fp-v2")[0]).toMatchObject({ sourceHeader: "人员代号", structureCompatible: false });
      expect(store.mappings("erp:leave", "fp-v1")).toEqual([]);
      expect(sourceIdentityScope("OA系统", "请假明细")).toMatch(/^source-[a-f0-9]{24}$/);
    } finally { await rm(directory, { recursive: true }); }
  });
});
