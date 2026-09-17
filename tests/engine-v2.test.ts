import { describe, expect, it } from "vitest";
import { executePlanBranchesV2, executePlanV2, type DataSetV2 } from "@ctd-abpa/core";
import { ProcessPlanV2Schema, ProcessPlanV3Schema, type RuleSetVersion, type TargetTemplateVersion } from "@ctd-abpa/types";

const trace = (row: number) => [{ artifactId: "artifact-expenses", sourceFile: "expenses.csv", sourceSheet: "Sheet1", sourceRow: row }];
const expenses: DataSetV2 = {
  columns: { employee_id: "text", department: "text", amount: "decimal", approved: "boolean" },
  rows: [
    { values: { employee_id: "E1", department: "A", amount: "10.25", approved: true }, lineage: trace(2) },
    { values: { employee_id: "E2", department: "B", amount: "5", approved: false }, lineage: trace(3) },
    { values: { employee_id: "E3", department: "A", amount: "3.75", approved: true }, lineage: trace(4) },
  ],
};
const master: DataSetV2 = {
  columns: { master_id: "text", master_department: "text", category: "text" },
  rows: [
    { values: { master_id: "E1", master_department: "A", category: "研发" }, lineage: [{ sourceFile: "master.xlsx", sourceSheet: "员工", sourceRow: 2 }] },
    { values: { master_id: "E3", master_department: "A", category: "研发" }, lineage: [{ sourceFile: "master.xlsx", sourceSheet: "员工", sourceRow: 3 }] },
  ],
};

function fixture() {
  const steps = [
    { stepId: "filtered", input: "expenses", operator: "filter", predicate: { kind: "all", items: [
      { kind: "compare", operator: "eq", left: { kind: "column", columnId: "approved" }, right: { kind: "literal", value: true } },
      { kind: "any", items: [
        { kind: "compare", operator: "eq", left: { kind: "column", columnId: "department" }, right: { kind: "literal", value: "A" } },
        { kind: "compare", operator: "eq", left: { kind: "column", columnId: "department" }, right: { kind: "literal", value: "C" } },
      ] },
    ] } },
    { stepId: "joined", input: "filtered", operator: "join", right: "master", joinType: "inner", cardinality: "many_to_one", leftKeys: ["employee_id", "department"], rightKeys: ["master_id", "master_department"], identityChecks: [] },
    { stepId: "calculated", input: "joined", operator: "calculate", assignments: [{ outputColumnId: "tax", dataType: "decimal", scale: 2, expression: { kind: "function", name: "round", arguments: [
      { kind: "binary", operator: "multiply", left: { kind: "column", columnId: "amount" }, right: { kind: "literal", value: "0.10" } },
      { kind: "literal", value: 2 },
    ] } }] },
    { stepId: "summary", input: "calculated", operator: "aggregate", groupBy: ["category"], metrics: [
      { outputColumnId: "total", function: "sum", columnId: "amount" },
      { outputColumnId: "count", function: "count" },
      { outputColumnId: "max_tax", function: "max", columnId: "tax" },
    ] },
    { stepId: "sorted", input: "summary", operator: "sort", keys: [{ columnId: "category", direction: "asc" }] },
  ];
  const plan = ProcessPlanV2Schema.parse({
    version: 2, planId: "plan.generic", revision: 1, rules: { id: "rules.generic", version: 1 },
    inputs: [
      { bindingId: "expenses", artifactId: "artifact-expenses", sheetId: "sheet-expenses", headerRows: [1], columns: Object.keys(expenses.columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) },
      { bindingId: "master", artifactId: "artifact-master", sheetId: "sheet-master", headerRows: [1], columns: Object.keys(master.columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) },
    ], steps, targetTemplate: { id: "template.summary", version: 1 },
  });
  const rules: RuleSetVersion = { id: "rules.generic", version: 1, name: "费用汇总", status: "published", aliases: {}, steps: plan.steps };
  const template: TargetTemplateVersion = { id: "template.summary", version: 1, format: "xlsx", sheets: [{ sheetId: "summary", name: "汇总", headerRow: 1, columns: [
    { columnId: "category", header: "分类", dataType: "text", required: true },
    { columnId: "total", header: "总额", dataType: "decimal", required: true },
    { columnId: "count", header: "数量", dataType: "integer", required: true },
    { columnId: "max_tax", header: "最高税额", dataType: "decimal", required: true },
  ] }] };
  return { plan, rules, template };
}

describe("受限通用执行引擎", () => {
  it("V3 显式绑定两个输出数据集与工作表", () => {
    const { plan: old, rules, template: oldTemplate } = fixture();
    const plan = ProcessPlanV3Schema.parse({ ...old, version: 3, outputs: [{ sheetId: "detail", datasetId: "filtered" }, { sheetId: "summary", datasetId: "sorted" }] });
    const template: TargetTemplateVersion = { ...oldTemplate, sheets: [
      { sheetId: "detail", name: "明细", headerRow: 1, columns: [{ columnId: "employee_id", header: "工号", dataType: "text" }] },
      { ...oldTemplate.sheets[0], sheetId: "summary" },
    ] };
    const result = executePlanV2({ plan, rules, template, bindings: { expenses, master } });
    expect(result.outputs.detail.rows).toHaveLength(2);
    expect(result.outputs.summary.rows).toHaveLength(1);
    expect(result.reconciliation.outputRows).toBe(3);
  });

  it("十进制求和、文本标识符、多值筛选和重命名元数据保持正确", () => {
    const data: DataSetV2 = { columns: { employee_id: "text", amount: "decimal" }, rows: Array.from({ length: 13 }, (_, index) => ({ values: { employee_id: index === 0 ? "001" : String(index), amount: "0.1" }, lineage: trace(index + 2) })) };
    const steps = [
      { stepId: "chosen", input: "source", operator: "filter", predicate: { kind: "compare", operator: "in", left: { kind: "column", columnId: "employee_id" }, right: ["001", "2", "3"].map((value) => ({ kind: "literal", value })) } },
      { stepId: "renamed", input: "chosen", operator: "rename", mappings: [{ from: "amount", to: "cost" }] },
      { stepId: "total", input: "renamed", operator: "aggregate", groupBy: [], metrics: [{ outputColumnId: "sum", function: "sum", columnId: "cost" }] },
    ];
    const plan = ProcessPlanV2Schema.parse({ version: 2, planId: "decimals", revision: 1, rules: { id: "decimals", version: 1 }, inputs: [{ bindingId: "source", artifactId: "source", sheetId: "source", headerRows: [1], columns: [{ columnId: "employee_id", sourceIndex: 0, sourceHeader: "employee_id" }, { columnId: "amount", sourceIndex: 1, sourceHeader: "amount" }] }], steps, targetTemplate: { id: "decimals", version: 1 } });
    const result = executePlanV2({ plan, bindings: { source: data }, rules: { id: "decimals", version: 1, name: "小数", status: "published", aliases: {}, steps: plan.steps }, template: { id: "decimals", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "输出", headerRow: 1, columns: [{ columnId: "sum", header: "合计", dataType: "decimal" }] }] } });
    expect(result.rows).toEqual([["0.3"]]);
    expect(result.exceptions).toHaveLength(0);
    expect(result.reconciliation.filteredRows).toBe(10);
    const allPlan = ProcessPlanV2Schema.parse({ ...plan, steps: [{ stepId: "total", input: "source", operator: "aggregate", groupBy: [], metrics: [{ outputColumnId: "sum", function: "sum", columnId: "amount" }] }] });
    const all = executePlanV2({ plan: allPlan, bindings: { source: data }, rules: { id: "decimals", version: 1, name: "小数", status: "published", aliases: {}, steps: allPlan.steps }, template: { id: "decimals", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "输出", headerRow: 1, columns: [{ columnId: "sum", header: "合计", dataType: "decimal" }] }] } });
    expect(all.rows).toEqual([["1.3"]]);
  });

  it("空关联键不匹配，即使右侧也为空", () => {
    const { plan, rules, template } = fixture();
    const left = { ...expenses, rows: [{ values: { employee_id: "", department: "A", amount: "1", approved: true }, lineage: trace(2) }] };
    const right = { ...master, rows: [{ values: { master_id: "", master_department: "A", category: "错误匹配" }, lineage: trace(2) }] };
    const result = executePlanV2({ plan, rules, template, bindings: { expenses: left, master: right } });
    expect(result.rows).toEqual([]);
    expect(result.reconciliation.filteredRows).toBe(1);
  });

  it("执行 AND/OR、复合键关联、白名单计算、聚合和排序并保留来源", () => {
    const result = executePlanV2({ ...fixture(), bindings: { expenses, master } });
    expect(result.rows).toEqual([["研发", "14", 2, "1.03"]]);
    expect(result.reconciliation).toEqual({ inputRows: 5, filteredRows: 1, isolatedRows: 0, outputRows: 1 });
    expect(result.data.rows[0].lineage).toHaveLength(4);
    expect(result.stages.map((stage) => [stage.stepId, stage.inputRows, stage.outputRows, stage.isolatedRows])).toEqual([
      ["filtered", 3, 2, 0], ["joined", 2, 2, 0], ["calculated", 2, 2, 0], ["summary", 2, 1, 0], ["sorted", 1, 1, 0],
    ]);
    expect(result.stages.find((stage) => stage.stepId === "joined")?.metrics).toMatchObject({ rightRows: 2, matchedRows: 2, unmatchedRows: 0, cardinalityErrors: 0, identityConflicts: 0 });
  });

  it("关联右表重复键时隔离正常输入而不放大结果", () => {
    const duplicateMaster = { ...master, rows: [...master.rows, { ...master.rows[0], lineage: [{ sourceFile: "master.xlsx", sourceSheet: "员工", sourceRow: 9 }] }] };
    const result = executePlanV2({ ...fixture(), bindings: { expenses, master: duplicateMaster } });
    expect(result.rows).toEqual([["研发", "3.75", 1, "0.38"]]);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].reason).toMatch(/基数/);
  });

  it("除零和未显式舍入的无限小数逐行隔离", () => {
    const { plan, rules, template } = fixture();
    const calculation = ProcessPlanV2Schema.parse({ ...plan, steps: [{ stepId: "bad", input: "expenses", operator: "calculate", assignments: [{ outputColumnId: "total", dataType: "decimal", expression: { kind: "binary", operator: "divide", left: { kind: "column", columnId: "amount" }, right: { kind: "literal", value: 0 } } }] }], targetTemplate: { id: "template.bad", version: 1 } });
    const badRules = { ...rules, steps: calculation.steps }, badTemplate = { ...template, id: "template.bad", sheets: [{ ...template.sheets[0], columns: [{ columnId: "total", header: "结果", dataType: "decimal" as const, required: true }] }] };
    const result = executePlanV2({ plan: calculation, bindings: { expenses, master }, rules: badRules, template: badTemplate });
    expect(result.rows).toHaveLength(0); expect(result.exceptions).toHaveLength(3);
  });

  it("执行空值、显式去重和字段选择", () => {
    const data: DataSetV2 = { columns: { sku: "text", warehouse: "text", quantity: "integer" }, rows: [
      { values: { sku: "S1", warehouse: null, quantity: 2 }, lineage: trace(2) },
      { values: { sku: "S1", warehouse: null, quantity: 3 }, lineage: trace(3) },
    ] };
    const plan = ProcessPlanV2Schema.parse({ version: 2, planId: "inventory", revision: 1, rules: { id: "inventory", version: 1 }, inputs: [{ bindingId: "stock", artifactId: "stock", sheetId: "stock", headerRows: [1], columns: Object.keys(data.columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) }], steps: [
      { stepId: "filled", input: "stock", operator: "fill_null", values: [{ columnId: "warehouse", value: "默认仓" }] },
      { stepId: "unique", input: "filled", operator: "deduplicate", keys: ["sku", "warehouse"], keep: "last" },
      { stepId: "selected", input: "unique", operator: "select", columns: ["sku", "quantity"] },
    ], targetTemplate: { id: "inventory", version: 1 } });
    const template: TargetTemplateVersion = { id: "inventory", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结存", headerRow: 1, columns: [{ columnId: "sku", header: "SKU", dataType: "text" }, { columnId: "quantity", header: "数量", dataType: "integer" }] }] };
    const result = executePlanV2({ plan, bindings: { stock: data }, rules: { id: "inventory", version: 1, name: "库存", status: "published", aliases: {}, steps: plan.steps }, template });
    expect(result.rows).toEqual([["S1", 3]]);
  });

  it("结构错误只暂停对应分支，独立分支继续", () => {
    const good = fixture();
    const branches = executePlanBranchesV2([
      { branchId: "good", ...good, bindings: { expenses, master } },
      { branchId: "bad", ...good, bindings: { expenses } },
    ]);
    expect(branches[0].result?.rows).toHaveLength(1); expect(branches[0].structuralError).toBeUndefined();
    expect(branches[1].result).toBeUndefined(); expect(branches[1].structuralError).toMatch(/缺少字段|输入绑定/);
  });

  it("按员工和稳定顺序逐笔消费整数分钟余额并保持守恒", () => {
    const data: DataSetV2 = { columns: { employee_id: "text", start: "date", document_no: "text", opening_minutes: "integer", demand_minutes: "integer" }, rows: [
      { values: { employee_id: "E1", start: "2026-04-02", document_no: "L2", opening_minutes: 1920, demand_minutes: 1440 }, lineage: trace(3) },
      { values: { employee_id: "E1", start: "2026-04-01", document_no: "L1", opening_minutes: 1920, demand_minutes: 1440 }, lineage: trace(2) },
    ] };
    const steps = [
      { stepId: "allocated", input: "leave", operator: "allocate_balance", groupBy: ["employee_id"], balanceColumn: "opening_minutes", demandColumn: "demand_minutes", orderBy: [{ columnId: "start", direction: "asc", nulls: "last" }, { columnId: "document_no", direction: "asc", nulls: "last" }], allocatedColumn: "annual_minutes", fallbackColumn: "personal_minutes", remainingColumn: "remaining_minutes" },
      { stepId: "split", input: "allocated", operator: "split_rows", branches: [
        { branchId: "annual", when: { kind: "compare", operator: "gt", left: { kind: "column", columnId: "annual_minutes" }, right: { kind: "literal", value: 0 } }, assignments: [{ outputColumnId: "leave_type", dataType: "text", expression: { kind: "literal", value: "年假" } }, { outputColumnId: "output_minutes", dataType: "integer", expression: { kind: "column", columnId: "annual_minutes" } }] },
        { branchId: "personal", when: { kind: "compare", operator: "gt", left: { kind: "column", columnId: "personal_minutes" }, right: { kind: "literal", value: 0 } }, assignments: [{ outputColumnId: "leave_type", dataType: "text", expression: { kind: "literal", value: "事假" } }, { outputColumnId: "output_minutes", dataType: "integer", expression: { kind: "column", columnId: "personal_minutes" } }] },
      ] },
    ] as const;
    const plan = ProcessPlanV3Schema.parse({ version: 3, planId: "leave-allocation", revision: 1, rules: { id: "leave-allocation", version: 1 }, inputs: [{ bindingId: "leave", artifactId: "leave", sheetId: "leave", headerRows: [1], columns: Object.keys(data.columns).map((columnId, sourceIndex) => ({ columnId, sourceIndex, sourceHeader: columnId })) }], steps, targetTemplate: { id: "leave-allocation", version: 1 }, parameters: { minutes_per_day: 480 }, outputs: [{ sheetId: "out", datasetId: "split" }] });
    const template: TargetTemplateVersion = { id: "leave-allocation", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结算", headerRow: 1, columns: [{ columnId: "document_no", header: "单号", dataType: "text" }, { columnId: "leave_type", header: "假别", dataType: "text" }, { columnId: "output_minutes", header: "分钟", dataType: "integer" }] }] };
    const result = executePlanV2({ plan, bindings: { leave: data }, rules: { id: "leave-allocation", version: 1, name: "顺序抵扣", status: "published", aliases: {}, steps: plan.steps, scope: { kind: "source", sourceIdentity: "oa:leave" } }, template });
    expect(result.rows).toEqual([["L1", "年假", 1440], ["L2", "年假", 480], ["L2", "事假", 960]]);
    expect(result.rows.reduce((sum, row) => sum + Number(row[2]), 0)).toBe(2880);
    expect(result.rows.filter((row) => row[1] === "年假").reduce((sum, row) => sum + Number(row[2]), 0)).toBe(1920);
    expect(result.stages.find((stage) => stage.stepId === "allocated")?.metrics).toEqual({ allocatedMinutes: 1920, fallbackMinutes: 960 });
    expect(result.stages.find((stage) => stage.stepId === "split")?.metrics).toEqual({ "branch.annual.rows": 2, "branch.personal.rows": 1 });
  });
});
