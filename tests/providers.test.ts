import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DeepSeekProvider, ReservedProvider, createModelProvider, type ModelProviderConfig } from "@ctd-abpa/core";

const config = (overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({ provider: "deepseek", model: "deployment-model", baseUrl: "https://model.invalid", apiKeyRef: "TEST_DEEPSEEK_KEY", timeoutMs: 100, maxRetries: 2, enabled: true, ...overrides });
const request = { system: "return JSON", instruction: "汇总费用", context: { headers: [["部门", "金额"]], rowCounts: [2], inferredTypes: [{ 金额: ["number"] }] }, schema: z.object({ operation: z.string() }), schemaName: "suggestion", example: { operation: "aggregate" } };
afterEach(() => { delete process.env.TEST_DEEPSEEK_KEY; delete process.env.TEST_SILICONFLOW_KEY; delete process.env.TEST_GEMINI_KEY; delete process.env.TEST_QWEN_KEY; });

describe("模型适配层", () => {
  it("DeepSeek 使用 Chat Completions JSON 模式并仅发送脱敏结构", async () => {
    process.env.TEST_DEEPSEEK_KEY = "secret"; let captured = "";
    const provider = new DeepSeekProvider(config(), async (_url, init) => { captured = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: "{\"operation\":\"aggregate\"}" } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { status: 200, headers: { "content-type": "application/json" } }); });
    const result = await provider.callStructured(request);
    expect(result.value.operation).toBe("aggregate"); expect(result.model).toBe("deployment-model"); expect(result.usage.totalTokens).toBe(12);
    expect(JSON.parse(captured).response_format).toEqual({ type: "json_object" });
    expect(JSON.parse(captured).messages[1].content).toContain("outputContract");
    expect(captured).not.toContain("secret"); expect(captured).not.toContain("/tmp/");
  });

  it("硅基流动使用独立密钥和 DeepSeek V4 Flash 模型调用 JSON 接口", async () => {
    process.env.TEST_SILICONFLOW_KEY = "siliconflow-secret";
    let calledUrl = "", authorization = "", captured = "";
    const provider = createModelProvider("siliconflow", config({ provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Flash", baseUrl: "https://api.siliconflow.cn/v1", apiKeyRef: "TEST_SILICONFLOW_KEY" }), async (url, init) => {
      calledUrl = String(url); authorization = new Headers(init?.headers).get("authorization") ?? ""; captured = String(init?.body);
      return new Response(JSON.stringify({ model: "deepseek-ai/DeepSeek-V4-Flash", choices: [{ finish_reason: "stop", message: { content: '{"operation":"aggregate"}' } }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await provider.callStructured(request);
    expect(calledUrl).toBe("https://api.siliconflow.cn/v1/chat/completions");
    expect(authorization).toBe("Bearer siliconflow-secret");
    expect(JSON.parse(captured)).toMatchObject({ model: "deepseek-ai/DeepSeek-V4-Flash", response_format: { type: "json_schema", json_schema: { name: "suggestion", strict: true } }, enable_thinking: false, temperature: 0, max_tokens: 8192 });
    expect(captured).not.toContain("siliconflow-secret");
    expect(result).toMatchObject({ provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Flash", finishReason: "stop", value: { operation: "aggregate" }, usage: { totalTokens: 11 } });
  });

  it("Gemini 使用原生 generateContent JSON 接口", async () => {
    process.env.TEST_GEMINI_KEY = "gemini-secret";
    let calledUrl = "", headers = new Headers(), captured = "";
    const provider = createModelProvider("gemini", config({ provider: "gemini", model: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyRef: "TEST_GEMINI_KEY" }), async (url, init) => {
      calledUrl = String(url); headers = new Headers(init?.headers); captured = String(init?.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"operation":"aggregate"}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await provider.callStructured(request);
    expect(calledUrl).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(headers.get("x-goog-api-key")).toBe("gemini-secret");
    expect(JSON.parse(captured)).toMatchObject({ generationConfig: { responseMimeType: "application/json" }, contents: [{ role: "user" }] });
    expect(captured).not.toContain("gemini-secret");
    expect(result).toMatchObject({ provider: "gemini", value: { operation: "aggregate" }, usage: { totalTokens: 10 } });
  });

  it("Qwen 使用百炼兼容接口和 JSON 非思考模式", async () => {
    process.env.TEST_QWEN_KEY = "qwen-secret";
    let calledUrl = "", headers = new Headers(), captured = "";
    const provider = createModelProvider("qwen", config({ provider: "qwen", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyRef: "TEST_QWEN_KEY" }), async (url, init) => {
      calledUrl = String(url); headers = new Headers(init?.headers); captured = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"operation":"aggregate"}' } }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await provider.callStructured(request);
    expect(calledUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer qwen-secret");
    expect(JSON.parse(captured)).toMatchObject({ model: "qwen-plus", response_format: { type: "json_object" }, enable_thinking: false });
    expect(captured).not.toContain("qwen-secret");
    expect(result).toMatchObject({ provider: "qwen", value: { operation: "aggregate" }, usage: { totalTokens: 11 } });
  });

  it("限流与服务错误最多重试两次", async () => {
    process.env.TEST_DEEPSEEK_KEY = "secret"; let calls = 0;
    const provider = new DeepSeekProvider(config(), async () => { calls++; return calls < 3 ? new Response("", { status: 429 }) : new Response(JSON.stringify({ choices: [{ message: { content: "{\"operation\":\"ok\"}" } }] }), { status: 200, headers: { "content-type": "application/json" } }); });
    expect((await provider.callStructured(request)).attempts).toBe(3); expect(calls).toBe(3);
  });

  it("不可重试参数错误立即停止，传输请求受共享预算约束", async () => {
    process.env.TEST_DEEPSEEK_KEY = "secret"; let calls = 0;
    const badRequest = new DeepSeekProvider(config(), async () => { calls++; return new Response("", { status: 400 }); });
    await expect(badRequest.callStructured(request)).rejects.toThrow(/400/); expect(calls).toBe(1);
    calls = 0; const limited = new DeepSeekProvider(config(), async () => { calls++; return new Response("", { status: 429 }); });
    await expect(limited.callStructured({ ...request, budget: { remainingRequests: 1, deadlineAt: Date.now() + 1000 } })).rejects.toThrow(/429/); expect(calls).toBe(1);
  });

  it("认证失败不重试，空响应不绕过本地 Schema", async () => {
    process.env.TEST_DEEPSEEK_KEY = "secret"; let calls = 0;
    const auth = new DeepSeekProvider(config(), async () => { calls++; return new Response("", { status: 401 }); });
    await expect(auth.callStructured(request)).rejects.toThrow(/认证失败/); expect(calls).toBe(1);
    const empty = new DeepSeekProvider(config(), async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(empty.callStructured(request)).rejects.toThrow(/空响应/);
    const truncated = new DeepSeekProvider(config(), async () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"operation\":" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(truncated.callStructured(request)).rejects.toThrow(/截断或非法 JSON/);
    const cutByLimit = new DeepSeekProvider(config(), async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"operation":"aggregate"}' } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(cutByLimit.callStructured(request)).rejects.toThrow(/长度限制被截断/);
  });

  it("超时按配置失败", async () => {
    process.env.TEST_DEEPSEEK_KEY = "secret";
    const provider = new DeepSeekProvider(config({ timeoutMs: 5, maxRetries: 0 }), async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    await expect(provider.callStructured(request)).rejects.toThrow(/超时/);
  });

  it("Gemini 和 Qwen 明确报告预留未启用", async () => {
    await expect(new ReservedProvider("gemini", { ...config(), provider: "gemini" }).callStructured(request)).rejects.toThrow(/预留，未启用/);
    await expect(new ReservedProvider("qwen", { ...config(), provider: "qwen" }).callStructured(request)).rejects.toThrow(/预留，未启用/);
  });
});
