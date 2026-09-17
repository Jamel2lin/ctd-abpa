import { describe, expect, it } from "vitest";
import { executePlanV2, type DataSetV2 } from "@ctd-abpa/core";
import { ProcessPlanV2Schema, type ProcessStepV2, type TargetTemplateVersion } from "@ctd-abpa/types";

function dataset(columns: DataSetV2["columns"], rows: Array<Record<string, DataSetV2["rows"][number]["values"][string]>>, source: string): DataSetV2 {
  return { columns, rows: rows.map((values, index) => ({ values, lineage: [{ sourceFile: source, sourceSheet: "数据", sourceRow: index + 2 }] })) };
}

function run(inputs: Record<string, DataSetV2>, steps: ProcessStepV2[], outputColumns: string[]) {
  const plan = ProcessPlanV2Schema.parse({
    version: 2, planId: "m4.generic", revision: 1, rules: { id: "m4.generic", version: 1 },
    inputs: Object.entries(inputs).map(([bindingId, data]) => ({
      bindingId, artifactId: `artifact-${bindingId}`, sheetId: `sheet-${bindingId}`, headerRows: [1],
      columns: Object.keys(data.columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })),
    })),
    steps, targetTemplate: { id: "m4.output", version: 1 },
  });
  const template: TargetTemplateVersion = { id: "m4.output", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: outputColumns.map((columnId) => ({ columnId, header: columnId, dataType: "text" })) }] };
  return executePlanV2({ plan, bindings: inputs, rules: { id: "m4.generic", version: 1, name: "M4 新场景", status: "published", aliases: {}, steps: plan.steps }, template });
}

describe("M4 非内置场景泛化验收", () => {
  it("员工主数据按工号关联，重复键隔离且完整保留来源", () => {
    const left = dataset({ employee_id: "text", employee_name: "text" }, [
      { employee_id: "001", employee_name: "甲" }, { employee_id: "002", employee_name: "乙" },
    ], "人员.csv");
    const right = dataset({ master_id: "text", master_name: "text", cost_center: "text" }, [
      { master_id: "001", master_name: "甲", cost_center: "A" },
      { master_id: "002", master_name: "乙", cost_center: "B" },
      { master_id: "002", master_name: "乙", cost_center: "C" },
    ], "主数据.csv");
    const result = run({ left, right }, [{ stepId: "joined", input: "left", operator: "join", right: "right", joinType: "inner", cardinality: "many_to_one", leftKeys: ["employee_id"], rightKeys: ["master_id"], identityChecks: [{ left: "employee_name", right: "master_name" }] }], ["employee_id", "cost_center"]);
    expect(result.rows).toEqual([["001", "A"]]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].sourceRow).toBe(3);
    expect(result.data.rows[0].lineage.map((item) => item.sourceFile)).toEqual(["人员.csv", "主数据.csv"]);
  });

  it("费用分类汇总：审批筛选、分类关联、非法金额隔离后精确求和", () => {
    const expenses = dataset({ business_type: "text", amount: "decimal", approved: "boolean" }, [
      { business_type: "TR", amount: "10.10", approved: true },
      { business_type: "TR", amount: "0.20", approved: true },
      { business_type: "ME", amount: "3.25", approved: true },
      { business_type: "TR", amount: "100", approved: false },
      { business_type: "ME", amount: "bad", approved: true },
    ], "费用.csv");
    const mapping = dataset({ map_type: "text", category: "text" }, [
      { map_type: "TR", category: "差旅" }, { map_type: "ME", category: "餐饮" },
    ], "分类.csv");
    const steps: ProcessStepV2[] = [
      { stepId: "approved", input: "expenses", operator: "filter", predicate: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "approved" }, right: { kind: "literal", value: true } } },
      { stepId: "classified", input: "approved", operator: "join", right: "mapping", joinType: "inner", cardinality: "many_to_one", leftKeys: ["business_type"], rightKeys: ["map_type"], identityChecks: [] },
      { stepId: "summary", input: "classified", operator: "aggregate", groupBy: ["category"], metrics: [{ outputColumnId: "total", function: "sum", columnId: "amount" }, { outputColumnId: "count", function: "count" }] },
      { stepId: "sorted", input: "summary", operator: "sort", keys: [{ columnId: "category", direction: "asc", nulls: "last" }] },
    ];
    const result = run({ expenses, mapping }, steps, ["category", "total", "count"]);
    expect(result.rows).toEqual([["差旅", "10.3", 2], ["餐饮", "3.25", 1]]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({ sourceFile: "费用.csv", sourceRow: 6, columnId: "amount", ruleId: "summary" });
    expect(result.reconciliation).toEqual({ inputRows: 7, filteredRows: 1, isolatedRows: 1, outputRows: 2 });
  });

  it("库存收发结存：按方向计算净变动，错误数量隔离", () => {
    const movements = dataset({ sku: "text", direction: "text", quantity: "decimal" }, [
      { sku: "S1", direction: "opening", quantity: "10" },
      { sku: "S1", direction: "in", quantity: "3.5" },
      { sku: "S1", direction: "out", quantity: "2.25" },
      { sku: "S2", direction: "opening", quantity: "4" },
      { sku: "S2", direction: "out", quantity: "invalid" },
    ], "收发.csv");
    const steps: ProcessStepV2[] = [
      { stepId: "signed", input: "movements", operator: "calculate", assignments: [{ outputColumnId: "signed_qty", dataType: "decimal", expression: {
        kind: "condition", when: { kind: "compare", operator: "eq", left: { kind: "column", columnId: "direction" }, right: { kind: "literal", value: "out" } },
        then: { kind: "binary", operator: "subtract", left: { kind: "literal", value: 0 }, right: { kind: "column", columnId: "quantity" } },
        otherwise: { kind: "column", columnId: "quantity" },
      } }] },
      { stepId: "balance", input: "signed", operator: "aggregate", groupBy: ["sku"], metrics: [{ outputColumnId: "ending_qty", function: "sum", columnId: "signed_qty" }] },
      { stepId: "sorted", input: "balance", operator: "sort", keys: [{ columnId: "sku", direction: "asc", nulls: "last" }] },
    ];
    const result = run({ movements }, steps, ["sku", "ending_qty"]);
    expect(result.rows).toEqual([["S1", "11.25"], ["S2", "4"]]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({ sourceFile: "收发.csv", sourceRow: 6, ruleId: "signed" });
  });
});
