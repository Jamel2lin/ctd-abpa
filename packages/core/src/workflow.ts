import { createHash } from "node:crypto";
import type { AnyProcessPlan, SourceArtifact, TaskRecord } from "@ctd-abpa/types";

export function planBindingHash(plan: AnyProcessPlan, files: SourceArtifact[], patches: TaskRecord["patches"] = [], config?: { rules?: unknown; template?: unknown; aliases?: unknown }): string {
  const payload = { plan, files: files.map((file) => ({ id: file.id, sha256: file.sha256, sheets: file.sheets.map((sheet) => ({ id: sheet.id, fingerprint: sheet.fingerprint })) })).sort((a, b) => a.id.localeCompare(b.id)), patches, config };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function invalidateConfirmation(task: TaskRecord): void {
  task.planRevision = (task.planRevision ?? 0) + 1;
  delete task.confirmation;
  delete task.previewHash;
  delete task.mappingSnapshot;
  delete task.staleBalanceCheck;
}

export function assertConfirmationCurrent(task: TaskRecord): void {
  const plan = task.generic?.plan ?? task.plan;
  if (!plan || !task.confirmation) throw new Error("计划尚未确认");
  const config = task.generic ? { rules: task.generic.rules, template: task.generic.template } : task.mappingSnapshot ? { aliases: task.mappingSnapshot } : undefined;
  if (task.confirmation.planRevision !== task.planRevision || task.confirmation.bindingHash !== planBindingHash(plan, task.files, task.patches, config)) throw new Error("来源、规则、模板或补丁已修改，原确认失效");
}
