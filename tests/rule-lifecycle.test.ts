import { describe, expect, it } from "vitest";
import { applyRulePatch, diffRuleRevisions, restoreRuleRevision, transitionRuleStatus } from "@ctd-abpa/core";
import { RuleSetVersionSchema } from "@ctd-abpa/types";

const draft = RuleSetVersionSchema.parse({ id: "rule.leave", version: 1, name: "请假规则", status: "draft", aliases: {}, steps: [], scope: { kind: "source", sourceIdentity: "oa:leave" } });

describe("规则修订生命周期", () => {
  it("只允许服务端顺序校验、确认和发布", () => {
    const validated = transitionRuleStatus(draft, "validated", "validator");
    const confirmed = transitionRuleStatus(validated, "confirmed", "Jamel", "2026-09-15T00:00:00.000Z");
    const published = transitionRuleStatus(confirmed, "published", "Jamel");
    expect(published.status).toBe("published"); expect(confirmed.confirmedBy).toBe("Jamel");
    expect(transitionRuleStatus(published, "superseded", "Jamel").status).toBe("superseded");
    expect(() => transitionRuleStatus(draft, "published", "Jamel")).toThrow(/非法规则状态转换/);
  });

  it("增量修改和恢复历史内容都创建新修订并使确认失效", () => {
    const revised = applyRulePatch(draft, { baseRevision: 1, rationale: "增加筛选", operations: [{ operation: "add_step", step: { stepId: "approved", input: "source", operator: "filter", predicate: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "approved" }, right: { kind: "literal", value: true } } } }] }, "Jamel");
    expect(revised).toMatchObject({ version: 2, parentRevision: 1, status: "draft", confirmedBy: undefined });
    const restored = restoreRuleRevision(draft, revised, "Jamel");
    expect(restored).toMatchObject({ version: 3, parentRevision: 2, steps: [], status: "draft" });
  });

  it("按步骤 ID 展示新增、删除、修改和顺序变化", () => {
    const second = applyRulePatch(draft, { baseRevision: 1, rationale: "增加筛选", operations: [{ operation: "add_step", step: { stepId: "approved", input: "source", operator: "filter", predicate: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "approved" }, right: { kind: "literal", value: true } } } }] }, "Jamel");
    expect(diffRuleRevisions(draft, second)).toMatchObject({ id: "rule.leave", fromVersion: 1, toVersion: 2, steps: { added: [{ stepId: "approved", operator: "filter", index: 0 }], removed: [], changed: [], reordered: [] } });
  });
});
