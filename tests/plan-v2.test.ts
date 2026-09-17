import { describe, expect, it } from "vitest";
import { validateAnyPlan, validatePlanV2 } from "@ctd-abpa/core";

function validPlan() {
  return {
    version: 2 as const,
    planId: "plan.expense-summary",
    revision: 1,
    rules: { id: "rules.expense", version: 3 },
    inputs: [{
      bindingId: "expenses",
      artifactId: "artifact-01",
      sheetId: "sheet-01",
      headerRows: [1, 2],
      columns: [
        { columnId: "department", sourceIndex: 0, sourceHeader: "部门" },
        { columnId: "amount", sourceIndex: 2, sourceHeader: "报销金额" },
      ],
    }],
    steps: [
      {
        stepId: "approved",
        input: "expenses",
        operator: "filter" as const,
        predicate: {
          kind: "all" as const,
          items: [
            { kind: "compare" as const, operator: "gte" as const, left: { kind: "column" as const, columnId: "amount" }, right: { kind: "literal" as const, value: 0 } },
            { kind: "compare" as const, operator: "in" as const, left: { kind: "column" as const, columnId: "department" }, right: [{ kind: "literal" as const, value: "财务部" }] },
          ],
        },
      },
      {
        stepId: "summary",
        input: "approved",
        operator: "aggregate" as const,
        groupBy: ["department"],
        metrics: [{ outputColumnId: "total_amount", function: "sum" as const, columnId: "amount" }],
      },
    ],
    targetTemplate: { id: "template.expense", version: 2 },
  };
}

describe("ProcessPlanV2 接口", () => {
  it("接受仅引用任务 artifact ID 的类型化计划", () => {
    expect(validatePlanV2(validPlan())).toEqual(validPlan());
    expect(validateAnyPlan(validPlan()).version).toBe(2);
  });

  it("拒绝任意路径和额外可执行字段", () => {
    const plan = validPlan() as Record<string, unknown>;
    plan.path = "/tmp/private.xlsx";
    plan.code = "return rows";
    expect(() => validatePlanV2(plan)).toThrow();
  });

  it("拒绝前向步骤引用和不等长复合关联键", () => {
    const plan = validPlan();
    plan.steps = [{
      stepId: "joined",
      input: "future-step",
      operator: "join",
      right: "expenses",
      joinType: "left",
      cardinality: "many_to_one",
      leftKeys: ["employee_id", "department"],
      rightKeys: ["employee_id"],
      identityChecks: [],
    }];
    expect(() => validatePlanV2(plan)).toThrow(/尚不存在|数量必须一致/);
  });

  it("拒绝表达式字符串和非白名单函数", () => {
    const plan = validPlan();
    plan.steps = [{
      stepId: "calculated",
      input: "expenses",
      operator: "calculate",
      assignments: [{ outputColumnId: "unsafe", dataType: "decimal", expression: "eval(amount)" }],
    }] as never;
    expect(() => validatePlanV2(plan)).toThrow();
  });
});
