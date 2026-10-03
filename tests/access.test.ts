import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@ctd-abpa/core";
import { accessSettings, actor, registerAccess } from "../apps/api/src/access.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tokens = { admin: "a".repeat(32), alice: "b".repeat(32), bob: "c".repeat(32), viewer: "d".repeat(32) };
async function server() {
  const root = await mkdtemp(join(tmpdir(), "ctd-access-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(root), app = Fastify(); cleanups.push(() => app.close());
  const settings = accessSettings({ API_USERS: JSON.stringify(Object.entries(tokens).map(([id, token]) => ({ id, token, role: id === "admin" ? "admin" : id === "viewer" ? "viewer" : "operator" }))) });
  registerAccess(app, store, settings);
  app.post("/api/tasks", async (req) => { const task = await store.create(); task.ownerId = actor(req).id; await store.save(task); return task; });
  app.get("/api/tasks", async (req) => (await store.list()).filter((task) => actor(req).role === "admin" || task.ownerId === actor(req).id));
  for (const path of ["/api/tasks/:id", "/api/tasks/:id/artifacts/:name", "/api/tasks/:id/runs/1/artifacts/:name", "/api/tasks/:id/events"]) app.get(path, async () => ({ ok: true }));
  for (const path of ["/api/tasks/:id/files", "/api/tasks/:id/patches", "/api/rules/test/revisions/1/publish", "/api/templates/test", "/api/tasks/:id/mappings/confirm"]) app.post(path, async () => ({ ok: true }));
  return { app, store, root };
}
const auth = (user: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[user]}` });

describe("访问权限", () => {
  it("外部监听必须认证，令牌必须独立且满足最低长度", () => {
    expect(() => accessSettings({ HOST: "0.0.0.0" })).toThrow(/身份认证/);
    expect(() => accessSettings({ API_USERS: '[{"id":"x","role":"admin","token":"short"}]' })).toThrow(/32/);
    expect(() => accessSettings({ CORS_ORIGINS: "*" })).toThrow();
  });
  it("匿名、未知 Origin 和 DNS 重绑定 Host 均拒绝", async () => {
    const { app } = await server();
    expect((await app.inject({ url: "/api/tasks" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/tasks", headers: { ...auth("admin"), origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/tasks", headers: { ...auth("admin"), host: "evil.example:3210" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/tasks", headers: { ...auth("admin"), origin: "http://127.0.0.1:3211" } })).statusCode).toBe(200);
  });
  it("任务、源上传、当前与历史下载、事件均按归属隔离；配置仅管理员写入", async () => {
    const { app } = await server();
    const task = (await app.inject({ method: "POST", url: "/api/tasks", headers: auth("alice") })).json();
    expect(task.ownerId).toBe("alice");
    expect((await app.inject({ url: "/api/tasks", headers: auth("bob") })).json()).toEqual([]);
    for (const path of [`/api/tasks/${task.id}`, `/api/tasks/${task.id}/artifacts/result.xlsx`, `/api/tasks/${task.id}/runs/1/artifacts/result.xlsx`, `/api/tasks/${task.id}/events`]) {
      expect((await app.inject({ url: path, headers: auth("bob") })).statusCode).toBe(403);
      expect((await app.inject({ url: path, headers: auth("alice") })).statusCode).toBe(200);
      expect((await app.inject({ url: path, headers: auth("admin") })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/files`, headers: auth("bob") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/files`, headers: auth("alice") })).statusCode).toBe(200);
    for (const path of ["/api/rules/test/revisions/1/publish", "/api/templates/test", `/api/tasks/${task.id}/mappings/confirm`]) {
      expect((await app.inject({ method: "POST", url: path, headers: auth("alice") })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: path, headers: auth("admin") })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: "/api/tasks", headers: auth("viewer") })).statusCode).toBe(403);
  });
  it("网页登录用 HttpOnly 会话，退出后失效，审计记录来自认证身份且不记录令牌", async () => {
    const { app, root } = await server();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { token: tokens.alice } });
    const setCookie = String(login.headers["set-cookie"]); expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0];
    expect((await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().user.id).toBe("alice");
    await app.inject({ method: "POST", url: "/api/tasks", headers: { cookie }, payload: { createdBy: "forged" } });
    const audit = await readFile(join(root, "access-audit.jsonl"), "utf8"); expect(audit).toContain('"actorId":"alice"'); expect(audit).not.toContain(tokens.alice); expect(audit).not.toContain("forged");
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await app.inject({ url: "/api/tasks", headers: { cookie } })).statusCode).toBe(401);
  });
});
