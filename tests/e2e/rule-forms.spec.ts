import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTabularSheet, readWorkbook } from "@ctd-abpa/excel";
const base = "http://127.0.0.1:3210";
async function upload(page: Page, files: Array<[string, string]>) {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await page.goto("/"); const task = await (await created).json();
  await page.locator('input[type="file"]').setInputFiles(files.map(([name, csv]) => ({ name, mimeType: "text/csv", buffer: Buffer.from(csv) })));
  await page.getByRole("button", { name: "上传并分析" }).click(); await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "通用表格任务" }).click();
  await page.locator(".rule-builder summary").click(); return task.id;
}
async function output(builder: Locator, id: string, header: string, type = "text") {
  await builder.getByRole("button", { name: "添加输出列", exact: true }).click();
  await builder.getByLabel("输出字段", { exact: true }).last().selectOption(id); await builder.getByLabel("表头文字", { exact: true }).last().fill(header); await builder.getByLabel("输出类型", { exact: true }).last().selectOption(type);
}
async function publishAndRun(page: Page, taskId: string, expected: unknown[][]) {
  const builder = page.locator(".rule-builder");
  await builder.getByRole("button", { name: "校验并保存表单配置" }).click(); await expect(page.getByText("表单配置已校验保存，请复核后确认发布", { exact: true })).toBeVisible();
  await builder.getByRole("button", { name: "确认并发布表单规则" }).click(); await expect(page.getByText("表单规则已确认并发布", { exact: true })).toBeVisible();
  await builder.getByRole("button", { name: "绑定表单计划" }).click(); await expect(page.getByText("表单计划已绑定，请完整预演", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完整预演" }).click(); await expect(page.getByRole("button", { name: "确认当前计划", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认当前计划", exact: true }).click(); await expect(page.locator(".status strong")).toHaveText("ready");
  await page.getByRole("button", { name: "执行并生成文件" }).click(); await expect(page.getByRole("link", { name: "目标文件", exact: true })).toBeVisible();
  const task = await (await page.request.get(`${base}/api/tasks/${taskId}`)).json();
  const response = await page.request.get(`${base}/api/tasks/${taskId}/artifacts/${encodeURIComponent(task.generic.result.outputFile)}`); expect(response.ok()).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "ctd-form-output-"));
  try { const path = join(root, "output.xlsx"); await writeFile(path, await response.body()); expect(readTabularSheet(await readWorkbook(path)).rows).toEqual(expected); } finally { await rm(root, { recursive: true, force: true }); }
  return task;
}

test("员工主数据关联：表单配置、身份核验、重复键隔离、文件黄金比对", async ({ page }) => {
  const id = await upload(page, [["人员.csv", "工号,姓名\n001,甲\n002,乙\n"], ["主数据.csv", "主工号,主姓名,成本中心\n001,甲,A\n002,乙,B\n002,乙,C\n"]]);
  const builder = page.locator(".rule-builder"); await builder.getByLabel("来源身份", { exact: true }).fill("test:employees");
  await builder.getByRole("button", { name: "添加关联", exact: true }).click();
  const step = builder.locator("fieldset").first(); await step.getByLabel("关联类型").selectOption("inner");
  await step.getByRole("button", { name: "增加身份核验" }).click(); await step.getByLabel("左身份字段").selectOption("s1c2"); await step.getByLabel("右身份字段").selectOption("s2c2");
  await output(builder, "s1c1", "工号"); await output(builder, "s2c3", "成本中心");
  const task = await publishAndRun(page, id, [["001", "A"]]); expect(task.generic.result.exceptions).toBe(1);
});

test("费用分类：类型转换、审批筛选、关联、汇总、黄金文件比对", async ({ page }) => {
  const id = await upload(page, [["费用.csv", "业务,金额,审批\nTR,10.10,true\nTR,0.20,true\nME,3.25,true\nTR,100,false\nME,bad,true\n"], ["分类.csv", "业务码,分类\nTR,差旅\nME,餐饮\n"]]);
  const builder = page.locator(".rule-builder"); await builder.getByLabel("来源身份", { exact: true }).fill("test:expenses");
  await builder.getByRole("button", { name: "添加转换", exact: true }).click(); const convert = builder.locator("fieldset").nth(0);
  await convert.getByLabel("字段", { exact: true }).selectOption("s1c2"); await convert.getByLabel("目标类型").selectOption("decimal");
  await convert.getByRole("button", { name: "增加转换字段" }).click(); await convert.getByLabel("字段", { exact: true }).nth(1).selectOption("s1c3"); await convert.getByLabel("目标类型").nth(1).selectOption("boolean");
  await builder.getByRole("button", { name: "添加筛选", exact: true }).click(); const filter = builder.locator("fieldset").nth(1);
  await filter.getByLabel("字段", { exact: true }).selectOption("s1c3"); await filter.getByLabel("取值类型").nth(1).selectOption("boolean"); await filter.getByLabel("布尔值").selectOption("true");
  await builder.getByRole("button", { name: "添加关联", exact: true }).click(); const joined = builder.locator("fieldset").nth(2); await joined.getByLabel("关联类型").selectOption("inner");
  await builder.getByRole("button", { name: "添加汇总", exact: true }).click(); const aggregate = builder.locator("fieldset").nth(3); await aggregate.getByLabel("分组字段（逗号分隔，可留空）").fill("s2c2"); await aggregate.getByLabel("字段", { exact: true }).selectOption("s1c2");
  await output(builder, "s2c2", "分类"); await output(builder, "total", "总额", "decimal");
  const task = await publishAndRun(page, id, [["差旅", 10.3], ["餐饮", 3.25]]); expect(task.generic.result.exceptions).toBe(1); expect(task.generic.result.reconciliation.filteredRows).toBe(1);
});

test("库存：映射计算、网页修正和排除、审计历史、已发布规则复用", async ({ page }) => {
  const id = await upload(page, [["库存.csv", "SKU,数量\nA,2\nB,bad\nC,3\n"]]); const builder = page.locator(".rule-builder"); await builder.getByLabel("来源身份", { exact: true }).fill("test:inventory-forms");
  await builder.getByRole("button", { name: "添加转换", exact: true }).click(); await builder.locator("fieldset").nth(0).getByLabel("字段", { exact: true }).selectOption("s1c2");
  await builder.getByRole("button", { name: "添加计算", exact: true }).click(); const calc = builder.locator("fieldset").nth(1); await calc.getByLabel("计算结果字段").fill("double_qty"); await calc.getByLabel("字段", { exact: true }).selectOption("s1c2"); await calc.getByLabel("计算方式").selectOption("multiply"); await calc.getByLabel("常量值").fill("2"); await calc.getByLabel("结果类型").selectOption("integer");
  await builder.getByRole("button", { name: "添加映射", exact: true }).click(); await builder.locator("fieldset").nth(2).getByLabel("新字段").fill("item_code");
  await output(builder, "item_code", "SKU"); await output(builder, "double_qty", "双倍数量", "integer");
  const first = await publishAndRun(page, id, [["A", 4], ["C", 6]]); expect(first.generic.result.exceptions).toBe(1);
  let answers = ["数量", "4", "独立复核数量", "合成来源记录INV-001"]; page.on("dialog", async (dialog) => { await dialog.accept(answers.shift() ?? ""); });
  await page.getByRole("button", { name: "上一步" }).click();
  await page.getByRole("button", { name: "修正源值并预览" }).first().click(); await expect(page.getByText("人工处理记录已保存并重算；请重新确认", { exact: true })).toBeVisible();
  expect((await page.request.post(`${base}/api/tasks/${id}/v2/execute`)).ok()).toBe(false);
  await page.getByRole("button", { name: "确认当前计划", exact: true }).click(); await expect(page.locator(".status strong")).toHaveText("ready"); await page.getByRole("button", { name: "执行并生成文件" }).click(); await expect(page.locator(".status strong")).toHaveText("completed");
  const second = await (await page.request.get(`${base}/api/tasks/${id}`)).json(); expect(second.runs).toHaveLength(2); expect(second.generic.result.outputRows).toBe(3); expect(second.runs[1].snapshot.patches[0].evidence).toBe("合成来源记录INV-001");
  const audit = await (await page.request.get(`${base}/api/tasks/${id}/artifacts/${encodeURIComponent("审计清单.json")}`)).json(); expect(audit.patches[0].reason).toBe("独立复核数量");
  const badPatch = { ...second.patches[0], exceptionId: "fault-injection", value: "bad", reason: "合成故障注入", evidence: "INV-002" }; expect((await page.request.post(`${base}/api/tasks/${id}/patches`, { data: badPatch })).ok()).toBe(true);
  await page.getByRole("button", { name: "上一步" }).click();
  await page.getByRole("button", { name: "完整预演" }).click(); answers = ["复核后排除无效记录", "合成来源记录INV-003"];
  await page.getByRole("button", { name: "排除源行并预览" }).first().click(); await expect(page.getByText("人工处理记录已保存并重算；请重新确认", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "确认当前计划", exact: true }).click(); await expect(page.locator(".status strong")).toHaveText("ready"); await page.getByRole("button", { name: "执行并生成文件" }).click(); await expect(page.locator(".status strong")).toHaveText("completed");
  const third = await (await page.request.get(`${base}/api/tasks/${id}`)).json(); expect(third.runs).toHaveLength(3); expect(third.generic.result.outputRows).toBe(2);
  expect((await page.request.get(`${base}/api/tasks/${id}/runs/1/artifacts/${encodeURIComponent(first.generic.result.outputFile)}`)).ok()).toBe(true);
  await page.getByRole("button", { name: "新建任务", exact: true }).click(); await page.locator('input[type="file"]').setInputFiles({ name: "库存.csv", mimeType: "text/csv", buffer: Buffer.from("SKU,数量\nD,5\n") }); await page.getByRole("button", { name: "上传并分析" }).click(); await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible();
  await page.locator(".rule-builder summary").click(); await builder.getByLabel("复用规则", { exact: true }).selectOption(`${first.generic.rules.id}@1`); await builder.getByLabel("复用目标模板", { exact: true }).selectOption(`${first.generic.template.id}@1`); await builder.getByRole("button", { name: "绑定表单计划" }).click(); await expect(page.getByText("表单计划已绑定，请完整预演", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "完整预演" }).click(); await expect(page.locator(".table").filter({ has: page.getByText("双倍数量", { exact: true }) })).toContainText("10");
  await page.getByRole("button", { name: "上一步" }).click();
  await builder.getByLabel("规则名称", { exact: true }).fill("库存修订"); await expect(builder.getByRole("button", { name: "绑定表单计划" })).toBeDisabled();
  await builder.getByRole("button", { name: "校验并保存表单配置" }).click(); await expect(builder.locator(".diff").first()).toContainText("库存修订"); await expect(builder.locator(".template-diff")).toBeVisible();
  await builder.getByRole("button", { name: "确认并发布表单规则" }).click(); await expect(page.getByText("表单规则已确认并发布", { exact: true })).toBeVisible();
  const revisions = await (await page.request.get(`${base}/api/rules`)).json(); expect(revisions.find((rule: any) => rule.id === first.generic.rules.id && rule.version === 2).name).toBe("库存修订");
});

test("去重：表单配置与黄金文件比对", async ({ page }) => {
  const id = await upload(page, [["库存.csv", "SKU,数量\nA,2\nA,2\nB,3\n"]]);
  const builder = page.locator(".rule-builder");
  await builder.getByLabel("来源身份", { exact: true }).fill("test:dedup");
  await builder.getByRole("button", { name: "去重", exact: true }).click();
  await output(builder, "s1c1", "SKU"); await output(builder, "s1c2", "数量");
  const task = await publishAndRun(page, id, [["A", "2"], ["B", "3"]]);
  expect(task.generic.result.exceptions).toBe(0);
});

test("余额分配：表单配置与黄金文件比对", async ({ page }) => {
  const id = await upload(page, [["余额.csv", "工号,余额,请假\n001,10,6\n001,10,8\n"]]);
  const builder = page.locator(".rule-builder");
  await builder.getByLabel("来源身份", { exact: true }).fill("test:alloc");
  await builder.getByRole("button", { name: "添加转换", exact: true }).click();
  const convert = builder.locator("fieldset").nth(0);
  await convert.getByLabel("字段", { exact: true }).selectOption("s1c2");
  await convert.getByLabel("目标类型").selectOption("integer");
  await convert.getByRole("button", { name: "增加转换字段" }).click();
  await convert.getByLabel("字段", { exact: true }).nth(1).selectOption("s1c3");
  await convert.getByLabel("目标类型").nth(1).selectOption("integer");
  await builder.getByRole("button", { name: "余额分配", exact: true }).click();
  const alloc = builder.locator("fieldset").nth(1);
  await alloc.getByLabel("分组字段（逗号分隔）").fill("s1c1");
  await alloc.getByLabel("余额字段").selectOption("s1c2");
  await alloc.getByLabel("需求字段").selectOption("s1c3");
  await output(builder, "s1c1", "工号"); await output(builder, "allocated", "年假"); await output(builder, "fallback", "事假");
  const task = await publishAndRun(page, id, [["001", "6", "0"], ["001", "4", "4"]]);
  expect(task.generic.result.exceptions).toBe(0);
});
