import { createHash } from "node:crypto";
import { ProcessStepV2Schema, RulePatchSchema, RuleSetVersionSchema, type RulePatch, type RuleSetVersion } from "@ctd-abpa/types";

export class RuleRevisionConflictError extends Error {
  constructor(expected: number, actual: number) { super(`规则基础修订冲突：请求 ${expected}，当前 ${actual}`); }
}

export function promptHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertUniqueStepIds(steps: RuleSetVersion["steps"]): void {
  const ids = steps.map((step) => step.stepId);
  if (new Set(ids).size !== ids.length) throw new Error("规则步骤 ID 必须唯一");
}

export function applyRulePatch(currentInput: RuleSetVersion, patchInput: RulePatch, editedBy: string): RuleSetVersion {
  const current = RuleSetVersionSchema.parse(currentInput), patch = RulePatchSchema.parse(patchInput);
  if (current.version !== patch.baseRevision) throw new RuleRevisionConflictError(patch.baseRevision, current.version);
  if (current.status === "superseded") throw new Error("已取代规则不能作为修订基础");
  const steps = current.steps.map((step) => structuredClone(step));
  for (const operation of patch.operations) {
    if (operation.operation === "add_step") {
      const index = operation.afterStepId ? steps.findIndex((step) => step.stepId === operation.afterStepId) : steps.length - 1;
      if (operation.afterStepId && index < 0) throw new Error(`增量修改目标步骤不存在: ${operation.afterStepId}`);
      steps.splice(index + 1, 0, ProcessStepV2Schema.parse(operation.step));
    } else {
      const index = steps.findIndex((step) => step.stepId === operation.stepId);
      if (index < 0) throw new Error(`增量修改目标步骤不存在: ${operation.stepId}`);
      if (operation.operation === "replace_step") steps[index] = ProcessStepV2Schema.parse(operation.step);
      else steps.splice(index, 1);
    }
  }
  assertUniqueStepIds(steps);
  return RuleSetVersionSchema.parse({
    ...current,
    version: current.version + 1,
    parentRevision: current.version,
    status: "draft",
    steps,
    confirmedBy: undefined,
    confirmedAt: undefined,
    provenance: { kind: "manual", editedBy },
    effectiveFrom: undefined,
  });
}

export function restoreRuleRevision(historyInput: RuleSetVersion, currentInput: RuleSetVersion, editedBy: string): RuleSetVersion {
  const history = RuleSetVersionSchema.parse(historyInput), current = RuleSetVersionSchema.parse(currentInput);
  if (history.id !== current.id) throw new Error("只能恢复同一规则的历史内容");
  return RuleSetVersionSchema.parse({ ...history, version: current.version + 1, parentRevision: current.version, status: "draft", confirmedBy: undefined, confirmedAt: undefined, effectiveFrom: undefined, provenance: { kind: "manual", editedBy } });
}

export function transitionRuleStatus(ruleInput: RuleSetVersion, target: "validated" | "confirmed" | "published" | "superseded", actor: string, at = new Date().toISOString()): RuleSetVersion {
  const rule = RuleSetVersionSchema.parse(ruleInput);
  const allowed: Record<RuleSetVersion["status"], RuleSetVersion["status"][]> = {
    draft: ["validated"], validated: ["confirmed"], confirmed: ["published"], published: ["superseded"], superseded: [],
  };
  if (!allowed[rule.status].includes(target)) throw new Error(`非法规则状态转换: ${rule.status} → ${target}`);
  if (target === "published" && rule.scope.kind !== "source") throw new Error("一次性规则不得发布为来源级长期规则");
  return RuleSetVersionSchema.parse({ ...rule, status: target, ...(target === "confirmed" ? { confirmedBy: actor, confirmedAt: at } : {}) });
}

export function diffRuleRevisions(fromInput: RuleSetVersion, toInput: RuleSetVersion) {
  const from = RuleSetVersionSchema.parse(fromInput), to = RuleSetVersionSchema.parse(toInput);
  if (from.id !== to.id) throw new Error("只能比较同一规则的修订");
  const fromSteps = new Map(from.steps.map((step, index) => [step.stepId, { step, index }]));
  const toSteps = new Map(to.steps.map((step, index) => [step.stepId, { step, index }]));
  const added = to.steps.flatMap((step, index) => fromSteps.has(step.stepId) ? [] : [{ stepId: step.stepId, operator: step.operator, index }]);
  const removed = from.steps.flatMap((step, index) => toSteps.has(step.stepId) ? [] : [{ stepId: step.stepId, operator: step.operator, index }]);
  const changed = to.steps.flatMap((step, toIndex) => {
    const previous = fromSteps.get(step.stepId);
    if (!previous || JSON.stringify(previous.step) === JSON.stringify(step)) return [];
    return [{ stepId: step.stepId, fromOperator: previous.step.operator, toOperator: step.operator, fromIndex: previous.index, toIndex }];
  });
  const reordered = to.steps.flatMap((step, toIndex) => {
    const previous = fromSteps.get(step.stepId);
    return previous && previous.index !== toIndex ? [{ stepId: step.stepId, fromIndex: previous.index, toIndex }] : [];
  });
  return { id: from.id, fromVersion: from.version, toVersion: to.version, name: { from: from.name, to: to.name }, aliases: { from: from.aliases, to: to.aliases }, status: { from: from.status, to: to.status }, scope: { from: from.scope, to: to.scope }, steps: { added, removed, changed, reordered } };
}
