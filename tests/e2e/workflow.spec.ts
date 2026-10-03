import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dataDir = resolve(process.env.CTD_TEST_DATA_DIR ?? "data/自动化桥接与处理智能体数据集file");

test("固定业务异常按存储来源定位，网页人工修正保留核实依据", async ({ page }) => {
  const created = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await page.goto("/"); const taskId = (await (await created).json()).id;
  await page.locator('input[type="file"]').setInputFiles({ name: "加班.csv", mimeType: "text/csv", buffer: Buffer.from("工号,姓名,部门,职位,起始日期,申请加班\n001,甲,A,员工,2026-04-02,-2\n") });
  await page.getByRole("button", { name: "上传并分析" }).click(); await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible();
  await page.locator("textarea").first().fill("将ERP加班转HR");
  await page.getByRole("button", { name: "生成业务计划" }).click(); await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.locator(".exception")).toContainText("OT_NEGATIVE_HOURS");
  const answers = ["申请加班", "2", "已人工核对 ERP 原单", "合成 ERP 原单 OT-001，仅用于测试"];
  page.on("dialog", async dialog => { await dialog.accept(answers.shift() ?? ""); });
  await page.getByRole("button", { name: "修正源值并预览" }).click();
  await expect(page.getByText("人工处理记录已保存并重算；请重新确认", { exact: true })).toBeVisible(); await expect(page.locator(".exception")).toHaveCount(0);
  const task = await (await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}`)).json();
  expect(task.patches[0]).toMatchObject({ artifactId: task.files[0].id, sourceRow: 2, value: "2", evidence: "合成 ERP 原单 OT-001，仅用于测试" });
  expect(task.confirmation).toBeUndefined();
});

test("同月余额只有月份时，网页与 API 均要求显式确认", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "ctd-month-e2e-"));
  const leave = join(directory, "leave.csv"), balance = join(directory, "balance.csv");
  try {
    await writeFile(leave, "工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号\n001,林一,A,事假,2026-04-02,08:00,2026-04-02,17:00,0,1,D001\n");
    await writeFile(balance, "2026年4月年假余额\n工号,姓名,部门,剩余年假\n001,林一,A,10\n");
    const created = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
    await page.goto("/");
    const taskId = (await (await created).json()).id;
    await page.locator('input[type="file"]').setInputFiles([leave, balance]);
    await page.getByRole("button", { name: "上传并分析" }).click();
    await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "生成业务计划" }).click();
    await page.getByRole("button", { name: "完整预演" }).click();
    await expect(page.getByText(/仅标注 2026-04，无法证明其截至日不早于/)).toBeVisible();
    await expect(page.getByRole("button", { name: "确认当前计划" })).toBeDisabled();
    const rejected = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: false } });
    expect(rejected.status()).toBe(400);
    const noSignature = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: true } }); expect(noSignature.status()).toBe(400);
    const stringConsent = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: "true", confirmedBy: "E2E", staleBalanceEvidence: "合成记录" } }); expect(stringConsent.status()).toBe(400);
    await page.locator("#stale-balance-check").check();
  await page.locator("#stale-confirmed-by").fill("E2E-HR");
  await page.locator("#stale-evidence").fill("合成验收记录 E2E-2026，仅用于测试");
    await page.getByRole("button", { name: "确认当前计划" }).click();
    await expect(page.locator(".status strong")).toHaveText("ready");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("上传、分析、确认、执行和下载", async ({ page }) => {
  test.skip(!["OA导出请假单.xlsx", "年假.xls"].every((file) => existsSync(resolve(dataDir, file))), "需本地授权数据");
  const created = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await page.goto("/");
  const initialTask = await (await created).json();
  await expect(page.locator(".status span")).not.toContainText("创建中");
  await page.locator('input[type="file"]').setInputFiles([
    resolve(dataDir, "OA导出请假单.xlsx"),
    resolve(dataDir, "年假.xls"),
  ]);
  await page.getByRole("button", { name: "上传并分析" }).click();
  await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "1. 文件与结构" }) }).locator(".file")).toHaveCount(2);
  await page.getByRole("button", { name: "生成业务计划" }).click();
  await expect(page.locator(".status strong")).toHaveText("awaiting_confirmation");
  await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.getByRole("heading", { name: "3. 预览与对账" })).toBeVisible();
  await expect(page.getByText(/inputRows: 13/)).toBeVisible();
  const taskId = initialTask.id, originalPlan = (await (await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}`)).json()).plan;
  await page.request.put(`http://127.0.0.1:3210/api/tasks/${taskId}/plan`, { data: originalPlan });
  const unconfirmed = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`); expect(unconfirmed.ok()).toBe(false);
  await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.getByText("余额时点可能过期")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认当前计划" })).toBeDisabled();
  const rejected = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: false } });
  expect(rejected.status()).toBe(400);
  await page.locator("#stale-balance-check").check();
  await page.locator("#stale-confirmed-by").fill("E2E-HR");
  await page.locator("#stale-evidence").fill("合成验收记录 E2E-2026，仅用于测试");
  await expect(page.getByRole("button", { name: "确认当前计划" })).toBeEnabled();
  await page.getByRole("button", { name: "确认当前计划" }).click();
  await expect(page.locator(".status strong")).toHaveText("ready");
  await page.getByRole("button", { name: "执行并生成文件" }).click();
  await expect(page.locator(".status strong")).toHaveText("completed_with_exceptions", { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "HR 导入文件" })).toBeVisible();
  await expect(page.getByRole("link", { name: "异常日志", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "年假对账" })).toBeVisible();
  await expect(page.getByRole("link", { name: "全部 ZIP" })).toBeVisible();
  const current = await (await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}`)).json();
  const leave = current.files.find((file: any) => file.kind === "leave"), sheet = leave.sheets[0];
  const excluded = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/patches`, { data: { reason: "E2E 人工复核", evidence: "合成 HR 主数据记录，仅用于测试", exceptionId: "manual", action: "exclude", artifactId: leave.id, sheetId: sheet.id, sourceRow: 4, createdBy: "E2E" } });
  expect(excluded.ok()).toBe(true);
  await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.getByRole("button", { name: "确认当前计划" })).toBeDisabled();
  await page.locator("#stale-balance-check").check();
  await page.locator("#stale-confirmed-by").fill("E2E-HR");
  await page.locator("#stale-evidence").fill("合成验收记录 E2E-2026，仅用于测试");
  await page.getByRole("button", { name: "确认当前计划" }).click();
  await expect(page.locator(".status strong")).toHaveText("ready");
  const rerun = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`); expect(rerun.ok(), await rerun.text()).toBe(true);
  const rerunTask = await rerun.json(); expect(rerunTask.runs).toHaveLength(2); expect(rerunTask.runs[0].outputDir).not.toBe(rerunTask.runs[1].outputDir);
  expect(rerunTask.runs[0].snapshot.patches).toHaveLength(0); expect(rerunTask.runs[1].snapshot.patches).toHaveLength(1);
  const historical = await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}/runs/1/artifacts/${encodeURIComponent("HR导入.xls")}`); expect(historical.ok()).toBe(true);
  expect([...await historical.body()].slice(0, 4)).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
  const daysColumn = sheet.columns.find((column: any) => column.header === "天");
  const patch = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/patches`, { data: { reason: "E2E 人工复核", evidence: "合成 HR 主数据记录，仅用于测试", exceptionId: "manual-correction", action: "correct", artifactId: leave.id, sheetId: sheet.id, sourceRow: 2, columnId: daysColumn.id, value: "0.5", createdBy: "E2E" } });
  expect(patch.ok()).toBe(true);
  await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.getByRole("button", { name: "确认当前计划" })).toBeDisabled();
  await page.locator("#stale-balance-check").check();
  await page.locator("#stale-confirmed-by").fill("E2E-HR");
  await page.locator("#stale-evidence").fill("合成验收记录 E2E-2026，仅用于测试");
  await page.getByRole("button", { name: "确认当前计划" }).click();
  await expect(page.locator(".status strong")).toHaveText("ready");
  const corrected = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`, { headers: { "Idempotency-Key": "e2e-corrected" } }); expect(corrected.ok()).toBe(true); expect((await corrected.json()).runs).toHaveLength(3);
  const repeated = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`, { headers: { "Idempotency-Key": "e2e-corrected" } }); expect(repeated.ok()).toBe(true); expect((await repeated.json()).runs).toHaveLength(3);
  const fourthPatch = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/patches`, { data: { reason: "E2E 人工复核", evidence: "合成 HR 主数据记录，仅用于测试", exceptionId: "cancel-case", action: "exclude", artifactId: leave.id, sheetId: sheet.id, sourceRow: 5, createdBy: "E2E" } }); expect(fourthPatch.ok()).toBe(true);
  expect((await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/preview`)).ok()).toBe(true);
  expect((await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: true, confirmedBy: "E2E", staleBalanceEvidence: "合成验收记录 E2E，仅用于测试" } })).ok()).toBe(true);
  const originalSource = await readFile(leave.path);
  await writeFile(leave.path, Buffer.concat([originalSource, Buffer.from("changed")]));
  const changedInput = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`);
  expect(changedInput.status()).toBe(409); expect(await changedInput.text()).toContain("源文件内容已变化");
  expect((await (await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}`)).json()).confirmation).toBeUndefined();
  await writeFile(leave.path, originalSource);
  expect((await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/preview`)).ok()).toBe(true);
  expect((await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/confirm`, { data: { allowStaleBalance: true, confirmedBy: "E2E", staleBalanceEvidence: "合成验收记录 E2E，仅用于测试" } })).ok()).toBe(true);
  const runningRequest = page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`, { headers: { "Idempotency-Key": "e2e-cancelled" } });
  await expect.poll(async () => (await (await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}`)).json()).status).toBe("running");
  const locked = await page.request.put(`http://127.0.0.1:3210/api/tasks/${taskId}/plan`, { data: originalPlan }); expect(locked.status()).toBe(409);
  const cancel = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/cancel`); expect(cancel.ok()).toBe(true);
  const cancelled = await runningRequest; expect(cancelled.ok(), await cancelled.text()).toBe(true);
  const cancelledTask = await cancelled.json(); expect(cancelledTask.status).toBe("cancelled"); expect(cancelledTask.runs.at(-1).status).toBe("cancelled");
  const unavailable = await page.request.get(`http://127.0.0.1:3210/api/tasks/${taskId}/runs/4/artifacts/${encodeURIComponent("HR导入.xls")}`); expect(unavailable.status()).toBe(404);
  const retry = await page.request.post(`http://127.0.0.1:3210/api/tasks/${taskId}/execute`, { headers: { "Idempotency-Key": "e2e-retry" } }); expect(retry.ok(), await retry.text()).toBe(true); expect((await retry.json()).runs).toHaveLength(5);
  const modelStatus = await (await page.request.get("http://127.0.0.1:3210/api/models/status")).json(); expect(JSON.stringify(modelStatus)).not.toContain("sk-");
  const ruleId = `e2e-${Date.now()}`; const saved = await page.request.put(`http://127.0.0.1:3210/api/rules/${ruleId}`, { data: { id: ruleId, version: 1, name: "E2E", status: "published", aliases: {}, steps: [] } }); expect(saved.ok()).toBe(true);
});

test("有明确截至日且覆盖请假日期时，网页无需旧余额确认", async ({ page }) => {
  await page.goto("/"); await expect(page.locator(".status span")).not.toContainText("创建中");
  await page.locator('input[type="file"]').setInputFiles([
    { name: "leave.csv", mimeType: "text/csv", buffer: Buffer.from("工号,申请人,部门,请假类型,起始日期,起始时间,结束日期,结束时间,小时,天,单据编号\n001,林一,A,事假,2026-04-02,08:00,2026-04-02,17:00,0,1,D001\n") },
    { name: "balance.csv", mimeType: "text/csv", buffer: Buffer.from("截至2026年4月2日年假余额\n工号,姓名,部门,剩余年假\n001,林一,A,10\n") },
  ]);
  await page.getByRole("button", { name: "上传并分析" }).click(); await expect(page.getByText("结构分析完成", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "生成业务计划" }).click(); await page.getByRole("button", { name: "完整预演" }).click();
  await expect(page.locator("#stale-balance-check")).toHaveCount(0); await expect(page.getByRole("button", { name: "确认当前计划" })).toBeEnabled(); await page.getByRole("button", { name: "确认当前计划" }).click(); await expect(page.locator(".status strong")).toHaveText("ready");
});
