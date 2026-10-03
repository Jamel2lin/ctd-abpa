import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = "http://127.0.0.1:3212", token = { admin: "admin-test-".padEnd(40, "a"), alice: "alice-test-".padEnd(40, "b"), bob: "bob-test-".padEnd(40, "c"), viewer: "viewer-test-".padEnd(40, "d") };
const headers = (id: keyof typeof token) => ({ authorization: `Bearer ${token[id]}` });
let child: ChildProcess, root: string;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ctd-auth-api-"));
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "apps/api/src/server.ts"], { env: { ...process.env, HOST: "127.0.0.1", PORT: "3212", TASK_STORAGE_DIR: root, CONFIG_STORAGE_DIR: join(root, "config"), EXECUTION_QUEUE_DELAY_MS: "300", MAX_PENDING_RUNS: "1", MAX_UPLOAD_BYTES: "1024", API_USERS: JSON.stringify(Object.entries(token).map(([id, token]) => ({ id, token, role: id === "admin" ? "admin" : id === "viewer" ? "viewer" : "operator" }))) }, stdio: "ignore" });
  await expect.poll(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, { timeout: 15000 }).toBe(true);
});
test.afterAll(async () => { if (child?.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); } if (root) await rm(root, { recursive: true, force: true }); });

test("实际 API：匿名与跨任务阻断、只读授权、上传限额、角色发布与可审计身份", async ({ request }) => {
  expect((await request.get(`${base}/api/tasks`)).status()).toBe(401);
  const task = await (await request.post(`${base}/api/tasks`, { headers: headers("alice") })).json();
  expect((await request.get(`${base}/api/tasks/${task.id}`, { headers: headers("bob") })).status()).toBe(403);
  expect((await request.get(`${base}/api/tasks/${task.id}/artifacts/result.xlsx`, { headers: headers("bob") })).status()).toBe(403);
  expect((await request.post(`${base}/api/tasks/${task.id}/files`, { headers: headers("bob"), multipart: { file: { name: "test.csv", mimeType: "text/csv", buffer: Buffer.from("SKU,数量\nA,2\n") } } })).status()).toBe(403);
  expect((await request.put(`${base}/api/tasks/${task.id}/access`, { headers: headers("alice"), data: { readers: ["bob"] } })).status()).toBe(403);
  expect((await request.put(`${base}/api/tasks/${task.id}/access`, { headers: headers("admin"), data: { readers: ["bob", "viewer"], editors: [] } })).ok()).toBe(true);
  expect((await request.get(`${base}/api/tasks/${task.id}`, { headers: headers("viewer") })).ok()).toBe(true);
  expect((await request.post(`${base}/api/tasks/${task.id}/analyze`, { headers: headers("bob") })).status()).toBe(403);
  expect((await request.delete(`${base}/api/tasks/${task.id}`, { headers: headers("viewer") })).status()).toBe(403);
  const oversized = await request.post(`${base}/api/tasks/${task.id}/files`, { headers: headers("alice"), multipart: { file: { name: "large.csv", mimeType: "text/csv", buffer: Buffer.from(`SKU,数量\n${"A,2\n".repeat(400)}`) } } }); expect(oversized.status()).toBe(413);
  expect((await request.get(`${base}/api/tasks/${task.id}`, { headers: headers("alice") })).ok()).toBe(true);
  const rule = { id: "auth-test", version: 1, name: "test", status: "published", steps: [] };
  expect((await request.put(`${base}/api/rules/auth-test`, { headers: headers("alice"), data: rule })).status()).toBe(403);
  const published = await request.put(`${base}/api/rules/auth-test`, { headers: headers("admin"), data: rule }); expect(published.ok()).toBe(true); expect((await published.json()).confirmedBy).toBe("admin");
  expect((await request.get(`${base}/api/metrics`, { headers: headers("alice") })).status()).toBe(403);
  const metrics = await (await request.get(`${base}/api/metrics`, { headers: headers("admin") })).json(); expect(metrics.upload.maxFileBytes).toBe(1024); expect(metrics.execution.limit).toBe(1);
  const audit = await readFile(join(root, "access-audit.jsonl"), "utf8"); expect(audit).toContain('"actorId":"alice"'); expect(audit).not.toContain(token.alice);
});

test("实际网页登录、Cookie 下载授权与退出失效", async ({ page }) => {
  await page.route("**/api/**", async (route) => { const url = new URL(route.request().url()); if (url.pathname.endsWith("/events")) { await route.fulfill({ contentType: "text/event-stream", body: "" }); return; } const response = await route.fetch({ url: `${base}${url.pathname}${url.search}` }); await route.fulfill({ response }); });
  const created = page.waitForResponse((response) => response.url().endsWith("/api/tasks") && response.request().method() === "POST");
  await page.goto("/"); await page.getByLabel("登录令牌").fill(token.alice); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByText("操作人：alice · operator")).toBeVisible(); await expect(page.locator(".status span")).not.toContainText("创建中");
  const task = await (await created).json(); await mkdir(join(root, task.id, "outputs"), { recursive: true }); await writeFile(join(root, task.id, "outputs", "cookie-test.txt"), "authorized fixture");
  expect((await page.request.get(`${base}/api/tasks/${task.id}/artifacts/cookie-test.txt`)).ok()).toBe(true);
  await page.getByRole("button", { name: "退出登录" }).click(); await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  expect((await page.request.get(`${base}/api/tasks/${task.id}`)).status()).toBe(401);
});

test("执行队列满时返回429，释放后可以执行并下载", async ({ request }) => {
  const rule = { id: "queue-test", version: 1, name: "队列回归", status: "published", steps: [] };
  const template = { id: "queue-target", version: 1, format: "xlsx", sheets: [{ sheetId: "out", name: "结果", headerRow: 1, columns: [{ columnId: "sku", header: "SKU", dataType: "text" }] }] };
  expect((await request.put(`${base}/api/rules/queue-test`, { headers: headers("admin"), data: rule })).ok()).toBe(true);
  expect((await request.put(`${base}/api/templates/queue-target`, { headers: headers("admin"), data: template })).ok()).toBe(true);
  const ids = [];
  for (let index = 0; index < 2; index++) {
    const task = await (await request.post(`${base}/api/tasks`, { headers: headers("alice") })).json(); ids.push(task.id);
    const files = await (await request.post(`${base}/api/tasks/${task.id}/files`, { headers: headers("alice"), multipart: { file: { name: "source.csv", mimeType: "text/csv", buffer: Buffer.from("SKU\nA\n") } } })).json(); const file = files[0], sheet = file.sheets[0];
    const plan = { version: 3, planId: `queue-${index}`, revision: 1, rules: { id: rule.id, version: 1 }, targetTemplate: { id: template.id, version: 1 }, inputs: [{ bindingId: "source", artifactId: file.id, sheetId: sheet.id, headerRows: [1], columns: [{ columnId: "sku", sourceIndex: 0, sourceHeader: "SKU" }] }], steps: [], parameters: {}, outputs: [{ sheetId: "out", datasetId: "source" }] };
    expect((await request.put(`${base}/api/tasks/${task.id}/v2/plan`, { headers: headers("alice"), data: plan })).ok()).toBe(true);
    expect((await request.post(`${base}/api/tasks/${task.id}/v2/preview`, { headers: headers("alice") })).ok()).toBe(true);
    expect((await request.post(`${base}/api/tasks/${task.id}/v2/confirm`, { headers: headers("alice"), data: {} })).ok()).toBe(true);
  }
  const first = request.post(`${base}/api/tasks/${ids[0]}/v2/execute`, { headers: headers("alice") });
  await expect.poll(async () => (await (await request.get(`${base}/api/tasks/${ids[0]}`, { headers: headers("alice") })).json()).status).toBe("running");
  const overloaded = await request.post(`${base}/api/tasks/${ids[1]}/v2/execute`, { headers: headers("alice") }); expect(overloaded.status()).toBe(429); expect(overloaded.headers()["retry-after"]).toBe("5"); expect((await first).ok()).toBe(true);
  expect((await request.post(`${base}/api/tasks/${ids[1]}/v2/execute`, { headers: headers("alice") })).ok()).toBe(true);
  expect((await request.get(`${base}/api/tasks/${ids[1]}/artifacts/${encodeURIComponent("目标输出.xlsx")}`, { headers: headers("alice") })).ok()).toBe(true);
  expect((await (await request.get(`${base}/api/metrics`, { headers: headers("admin") })).json()).execution.pending).toBe(0);
});
