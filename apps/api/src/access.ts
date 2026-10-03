import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TaskStore } from "@ctd-abpa/core";
import type { TaskRecord } from "@ctd-abpa/types";

export type Principal = { id: string; role: "admin" | "operator" | "viewer" };
type User = Principal & { token: string };
const principals = new WeakMap<FastifyRequest, Principal>();
export function actor(req: FastifyRequest): Principal { return principals.get(req) ?? { id: "local-user", role: "admin" }; }
export function canReadTask(task: TaskRecord, principal: Principal): boolean { return principal.role === "admin" || task.ownerId === principal.id || Boolean(task.access?.readers.includes(principal.id) || task.access?.editors.includes(principal.id)); }
export function accessSettings(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST ?? "127.0.0.1";
  const users: User[] = env.API_USERS ? JSON.parse(env.API_USERS) : [];
  if (!Array.isArray(users) || users.some((user) => !/^[A-Za-z0-9._-]{1,128}$/.test(user.id) || !["admin", "operator", "viewer"].includes(user.role) || typeof user.token !== "string" || user.token.length < 32) || new Set(users.map((user) => user.id)).size !== users.length || new Set(users.map((user) => user.token)).size !== users.length) throw new Error("API_USERS 必须为具有唯一 ID、角色和至少 32 字符独立令牌的用户数组");
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !users.length) throw new Error("外部监听必须配置 API_USERS 身份认证");
  const origins = (env.CORS_ORIGINS ?? "http://127.0.0.1:3211,http://localhost:3211,http://127.0.0.1:3210,http://localhost:3210").split(",").map((value) => value.trim()).filter(Boolean);
  for (const origin of origins) if (new URL(origin).origin !== origin) throw new Error("CORS_ORIGINS 必须为完整 origin，禁止通配符或路径");
  const hosts = new Set(["127.0.0.1", "localhost", "[::1]", ...origins.map((origin) => new URL(origin).hostname), ...(env.API_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean)]);
  return { users, origins, hosts, secureCookie: env.AUTH_COOKIE_SECURE === "true" };
}

export function registerAccess(app: FastifyInstance, store: TaskStore, settings = accessSettings()) {
  const sessions = new Map<string, { principal: Principal; expires: number }>();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const fromToken = (token: string) => settings.users.find((user) => timingSafeEqual(digest(token), digest(user.token)));
  const cookie = (req: FastifyRequest) => /(?:^|;\s*)ctd_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (!settings.hosts.has(req.hostname)) return reply.code(403).send({ error: "请求 Host 不在允许范围内" });
    if (req.headers.origin && !settings.origins.includes(req.headers.origin)) return reply.code(403).send({ error: "请求来源不在允许范围内" });
    let principal: Principal | undefined;
    if (!settings.users.length) principal = { id: "local-user", role: "admin" };
    else {
      const user = fromToken(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      if (user) principal = { id: user.id, role: user.role };
      const sessionId = cookie(req), session = sessionId ? sessions.get(sessionId) : undefined;
      if (!principal && session && session.expires > Date.now()) principal = session.principal;
      if (sessionId && session && session.expires <= Date.now()) sessions.delete(sessionId);
    }
    if (principal) principals.set(req, principal);
    if (["/health", "/api/auth/session", "/api/auth/login"].includes(path) || req.method === "OPTIONS") return;
    if (!principal) return reply.code(401).send({ error: "请先登录" });
  });
  app.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0], principal = actor(req), mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (path.startsWith("/api/auth/")) return;
    if (mutation && principal.role === "viewer") return reply.code(403).send({ error: "只读角色不能修改数据" });
    if (mutation && /^\/api\/(rules|templates|profiles)(?:\/|$)/.test(path) && principal.role !== "admin") return reply.code(403).send({ error: "配置发布和修订需要管理员权限" });
    const id = /^\/api\/tasks\/([^/]+)/.exec(path)?.[1];
    if (id) {
      const task = await store.get(decodeURIComponent(id));
      if (!canReadTask(task, principal)) return reply.code(403).send({ error: "无权访问其他用户的任务" });
      if (mutation && principal.role !== "admin" && task.ownerId !== principal.id && !task.access?.editors.includes(principal.id)) return reply.code(403).send({ error: "当前任务仅授权读取" });
      if (mutation && path.endsWith("/access") && principal.role !== "admin") return reply.code(403).send({ error: "任务授权需要管理员权限" });
      if (mutation && /\/mappings(?:\/|$)/.test(path) && principal.role !== "admin") return reply.code(403).send({ error: "共享字段映射需要管理员权限" });
    }
    if (mutation && settings.users.length && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      const body = req.body as Record<string, unknown>;
      for (const field of ["createdBy", "editedBy", "publishedBy", "supersededBy", "confirmedBy"]) {
        if (field === "confirmedBy" && path.endsWith("/confirm") && body.allowStaleBalance === true) continue;
        if (field in body) body[field] = principal.id;
      }
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    if ((!["GET", "HEAD", "OPTIONS"].includes(req.method) || req.url.includes("/artifacts/")) && req.url.startsWith("/api/") && !req.url.startsWith("/api/auth/")) {
      await appendFile(join(store.root, "access-audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), actorId: principals.get(req)?.id ?? "anonymous", role: principals.get(req)?.role ?? "anonymous", method: req.method, path: req.url.split("?")[0], status: reply.statusCode })}\n`, { mode: 0o600 });
    }
  });
  app.get("/api/auth/session", async (req) => ({ authenticationRequired: settings.users.length > 0, user: principals.get(req) ?? null }));
  app.post("/api/auth/login", async (req, reply) => {
    const token = (req.body as { token?: unknown })?.token;
    const user = typeof token === "string" ? fromToken(token) : undefined;
    if (!user) return reply.code(401).send({ error: "登录令牌无效" });
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 1000) return reply.code(429).send({ error: "登录会话已满，请稍后重试" });
    const sessionId = randomBytes(32).toString("hex"), principal = { id: user.id, role: user.role };
    sessions.set(sessionId, { principal, expires: Date.now() + 8 * 3_600_000 });
    return reply.header("set-cookie", `ctd_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${settings.secureCookie ? "; Secure" : ""}`).send({ user: principal });
  });
  app.post("/api/auth/logout", async (req, reply) => { const id = cookie(req); if (id) sessions.delete(id); return reply.header("set-cookie", "ctd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0").send({ ok: true }); });
}
