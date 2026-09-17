import { z } from "zod";

export type ModelProviderId = "deepseek" | "siliconflow" | "openai" | "gemini" | "qwen";
export interface ModelProviderConfig { provider: ModelProviderId; model: string; baseUrl: string; apiKeyRef: string; timeoutMs: number; maxRetries: number; enabled: boolean; }
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; }
export interface ModelCallResult<T> { status: "success"; provider: ModelProviderId; model: string; value: T; usage: ModelUsage; attempts: number; latencyMs?: number; finishReason?: string; }
export interface ModelCallBudget { remainingRequests: number; deadlineAt: number; }
export interface StructuredModelRequest<T> { system: string; instruction: string; context: Record<string, unknown>; schema: z.ZodType<T>; schemaName: string; jsonSchema?: Record<string, unknown>; example: unknown; budget?: ModelCallBudget; }
export interface ModelProvider { readonly id: ModelProviderId; readonly capability: "enabled" | "reserved"; callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>>; }

export class ModelResponseError extends Error {
  constructor(readonly code: "MODEL_EMPTY_RESPONSE" | "MODEL_TRUNCATED_RESPONSE" | "MODEL_INCOMPLETE_RESPONSE" | "MODEL_INVALID_JSON" | "MODEL_SCHEMA_INVALID", message: string, readonly path?: Array<string | number>, readonly draft?: unknown) { super(message); }
}

type Fetch = typeof fetch;
function key(config: ModelProviderConfig): string {
  const value = process.env[config.apiKeyRef]; if (!value) throw new Error(`未配置密钥引用: ${config.apiKeyRef}`); return value;
}
function retryable(status: number): boolean { return status === 408 || status === 429 || status >= 500; }
function extractJson(text: string): unknown {
  if (!text.trim()) throw new ModelResponseError("MODEL_EMPTY_RESPONSE", "模型返回空响应");
  try { return JSON.parse(text); } catch { throw new ModelResponseError("MODEL_INVALID_JSON", "模型返回截断或非法 JSON", undefined, text.slice(0, 4000)); }
}

function parseStructured<T>(request: StructuredModelRequest<T>, text: string): T {
  const draft = extractJson(text), parsed = request.schema.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ModelResponseError("MODEL_SCHEMA_INVALID", `模型结构错误: ${first?.message ?? "未知错误"}`, first?.path.map((item) => typeof item === "symbol" ? String(item) : item), draft);
  }
  return parsed.data;
}

function outputContract<T>(request: StructuredModelRequest<T>): unknown {
  return request.jsonSchema ?? z.toJSONSchema(request.schema, { unrepresentable: "any" });
}

abstract class HttpProvider implements ModelProvider {
  abstract readonly capability: "enabled" | "reserved";
  constructor(readonly id: ModelProviderId, protected readonly config: ModelProviderConfig, protected readonly fetcher: Fetch = fetch) {}
  protected async request(url: string, init: RequestInit, budget?: ModelCallBudget): Promise<{ body: unknown; attempts: number; latencyMs: number }> {
    const startedAt = Date.now();
    const attempts = this.config.maxRetries + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (budget && (budget.remainingRequests <= 0 || Date.now() >= budget.deadlineAt)) throw new Error("模型请求与修复共享预算已耗尽");
      if (budget) budget.remainingRequests--;
      const remainingMs = budget ? budget.deadlineAt - Date.now() : this.config.timeoutMs;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(this.config.timeoutMs, remainingMs)));
      try {
        const response = await this.fetcher(url, { ...init, signal: controller.signal });
        if (response.status === 401 || response.status === 403) throw new Error("模型认证失败，请检查密钥引用");
        if (!response.ok) {
          if (retryable(response.status) && attempt < attempts && (!budget || budget.remainingRequests > 0)) { await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 200 * 2 ** (attempt - 1)))); continue; }
          throw new Error(`模型服务错误: ${response.status}`);
        }
        return { body: await response.json(), attempts: attempt, latencyMs: Date.now() - startedAt };
      } catch (error) {
        if ((error as Error).message.includes("认证失败")) throw error;
        if (/^模型服务错误: 4\d\d$/.test((error as Error).message) && !/^模型服务错误: (?:408|429)$/.test((error as Error).message)) throw error;
        if (attempt === attempts || (budget && budget.remainingRequests <= 0)) throw new Error((error as Error).name === "AbortError" ? "模型调用超时" : (error as Error).message);
      } finally { clearTimeout(timeout); }
    }
    throw new Error("模型调用失败");
  }
  abstract callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>>;
}

export class DeepSeekProvider extends HttpProvider {
  readonly capability = "enabled" as const;
  constructor(config: ModelProviderConfig, fetcher?: Fetch) { super("deepseek", config, fetcher); }
  async callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> {
    if (!this.config.enabled) throw new Error("DeepSeek 未启用");
    const prompt = { instruction: request.instruction, context: request.context, outputContract: outputContract(request), validExample: request.example };
    const { body, attempts, latencyMs } = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key(this.config)}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, messages: [{ role: "system", content: `${request.system}\n严格遵循 outputContract，只输出 JSON，不得生成代码或结果数据。` }, { role: "user", content: JSON.stringify(prompt) }], response_format: { type: "json_object" }, max_tokens: 4096 }) }, request.budget);
    const data = body as { model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === "length") throw new ModelResponseError("MODEL_TRUNCATED_RESPONSE", "模型响应因长度限制被截断", undefined, data.choices?.[0]?.message?.content?.slice(0, 4000));
    if (finishReason && finishReason !== "stop") throw new ModelResponseError("MODEL_INCOMPLETE_RESPONSE", `模型未正常完成响应: ${finishReason}`, undefined, data.choices?.[0]?.message?.content?.slice(0, 4000));
    const value = parseStructured(request, data.choices?.[0]?.message?.content ?? "");
    return { status: "success", provider: this.id, model: data.model ?? this.config.model, value, attempts, latencyMs, finishReason, usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens } };
  }
}

export class SiliconFlowProvider extends HttpProvider {
  readonly capability = "enabled" as const;
  constructor(config: ModelProviderConfig, fetcher?: Fetch) { super("siliconflow", config, fetcher); }
  async callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> {
    if (!this.config.enabled) throw new Error("硅基流动未启用");
    const contract = outputContract(request);
    const prompt = { instruction: request.instruction, context: request.context, validExample: request.example };
    const { body, attempts, latencyMs } = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key(this.config)}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, messages: [{ role: "system", content: `${request.system}\n严格遵循 outputContract，只输出 JSON，不得生成代码或结果数据。` }, { role: "user", content: JSON.stringify(prompt) }], response_format: { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: contract } }, enable_thinking: false, temperature: 0, max_tokens: Number(process.env.SILICONFLOW_MAX_TOKENS ?? 8192) }) }, request.budget);
    const data = body as { model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === "length") throw new ModelResponseError("MODEL_TRUNCATED_RESPONSE", "模型响应因长度限制被截断", undefined, data.choices?.[0]?.message?.content?.slice(0, 4000));
    if (finishReason && finishReason !== "stop") throw new ModelResponseError("MODEL_INCOMPLETE_RESPONSE", `模型未正常完成响应: ${finishReason}`, undefined, data.choices?.[0]?.message?.content?.slice(0, 4000));
    const value = parseStructured(request, data.choices?.[0]?.message?.content ?? "");
    return { status: "success", provider: this.id, model: data.model ?? this.config.model, value, attempts, latencyMs, finishReason, usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens } };
  }
}

export class GeminiProvider extends HttpProvider {
  readonly capability = "enabled" as const;
  constructor(config: ModelProviderConfig, fetcher?: Fetch) { super("gemini", config, fetcher); }
  async callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> {
    if (!this.config.enabled) throw new Error("Gemini 未启用");
    const prompt = { instruction: request.instruction, context: request.context, outputContract: outputContract(request), validExample: request.example };
    const { body, attempts, latencyMs } = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(this.config.model)}:generateContent`, { method: "POST", headers: { "x-goog-api-key": key(this.config), "content-type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: `${request.system}\n严格遵循 outputContract，只输出 JSON，不得生成代码或结果数据。` }] }, contents: [{ role: "user", parts: [{ text: JSON.stringify(prompt) }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 } }) }, request.budget);
    const data = body as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } };
    const content = data.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("") ?? "";
    return { status: "success", provider: this.id, model: this.config.model, value: parseStructured(request, content), attempts, latencyMs, usage: { inputTokens: data.usageMetadata?.promptTokenCount, outputTokens: data.usageMetadata?.candidatesTokenCount, totalTokens: data.usageMetadata?.totalTokenCount } };
  }
}

export class QwenProvider extends HttpProvider {
  readonly capability = "enabled" as const;
  constructor(config: ModelProviderConfig, fetcher?: Fetch) { super("qwen", config, fetcher); }
  async callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> {
    if (!this.config.enabled) throw new Error("Qwen 未启用");
    const prompt = { instruction: request.instruction, context: request.context, outputContract: outputContract(request), validExample: request.example };
    const { body, attempts, latencyMs } = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key(this.config)}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, messages: [{ role: "system", content: `${request.system}\n严格遵循 outputContract，只输出 JSON，不得生成代码或结果数据。` }, { role: "user", content: JSON.stringify(prompt) }], response_format: { type: "json_object" }, enable_thinking: false, max_tokens: 4096 }) }, request.budget);
    const data = body as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    return { status: "success", provider: this.id, model: this.config.model, value: parseStructured(request, data.choices?.[0]?.message?.content ?? ""), attempts, latencyMs, usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, totalTokens: data.usage?.total_tokens } };
  }
}

export class OpenAIResponsesProvider extends HttpProvider {
  readonly capability = "reserved" as const;
  constructor(config: ModelProviderConfig, fetcher?: Fetch) { super("openai", config, fetcher); }
  async callStructured<T>(request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> {
    if (!this.config.enabled) throw new Error("OpenAI 预留，未启用");
    if (!request.jsonSchema) throw new Error("OpenAI 结构化输出缺少 JSON Schema");
    const { body, attempts, latencyMs } = await this.request(`${this.config.baseUrl.replace(/\/$/, "")}/responses`, { method: "POST", headers: { authorization: `Bearer ${key(this.config)}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, store: false, instructions: request.system, input: JSON.stringify({ instruction: request.instruction, context: request.context }), text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.jsonSchema } } }) }, request.budget);
    const data = body as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
    const text = data.output_text ?? data.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
    return { status: "success", provider: this.id, model: this.config.model, value: parseStructured(request, text), attempts, latencyMs, usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens, totalTokens: data.usage?.total_tokens } };
  }
}

export class ReservedProvider implements ModelProvider {
  readonly capability = "reserved" as const;
  constructor(readonly id: "gemini" | "qwen", private readonly config: ModelProviderConfig) {}
  async callStructured<T>(_request: StructuredModelRequest<T>): Promise<ModelCallResult<T>> { throw new Error(`${this.id === "gemini" ? "Gemini" : "Qwen"} 预留，未启用（配置模型: ${this.config.model || "未指定"}）`); }
}

export function modelConfigsFromEnv(): Record<ModelProviderId, ModelProviderConfig> {
  return {
    deepseek: { provider: "deepseek", model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash", baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", apiKeyRef: process.env.DEEPSEEK_API_KEY_REF ?? "DEEPSEEK_API_KEY", timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 30_000), maxRetries: 2, enabled: true },
    siliconflow: { provider: "siliconflow", model: process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V4-Flash", baseUrl: process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1", apiKeyRef: process.env.SILICONFLOW_API_KEY_REF ?? "SILICONFLOW_API_KEY", timeoutMs: Number(process.env.SILICONFLOW_TIMEOUT_MS ?? 30_000), maxRetries: 2, enabled: true },
    openai: { provider: "openai", model: process.env.OPENAI_MODEL ?? "", baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKeyRef: process.env.OPENAI_API_KEY_REF ?? "OPENAI_API_KEY", timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 30_000), maxRetries: 2, enabled: process.env.OPENAI_ENABLED === "true" },
    gemini: { provider: "gemini", model: process.env.GEMINI_MODEL || "gemini-2.5-flash", baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta", apiKeyRef: process.env.GEMINI_API_KEY_REF ?? "GEMINI_API_KEY", timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS ?? 30_000), maxRetries: 2, enabled: true },
    qwen: { provider: "qwen", model: process.env.QWEN_MODEL || "qwen-plus", baseUrl: process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyRef: process.env.QWEN_API_KEY_REF ?? "QWEN_API_KEY", timeoutMs: Number(process.env.QWEN_TIMEOUT_MS ?? 30_000), maxRetries: 2, enabled: true },
  };
}
export function createModelProvider(id: ModelProviderId, config = modelConfigsFromEnv()[id], fetcher?: Fetch): ModelProvider {
  if (id === "deepseek") return new DeepSeekProvider(config, fetcher);
  if (id === "siliconflow") return new SiliconFlowProvider(config, fetcher);
  if (id === "openai") return new OpenAIResponsesProvider(config, fetcher);
  if (id === "gemini") return new GeminiProvider(config, fetcher);
  if (id === "qwen") return new QwenProvider(config, fetcher);
  return new ReservedProvider(id, config);
}
export function publicModelStatus(configs = modelConfigsFromEnv()) { return Object.values(configs).map(({ apiKeyRef, ...config }) => ({ ...config, apiKeyConfigured: Boolean(process.env[apiKeyRef]), apiKeyRef })); }
