import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";
import { parseSseJsonStream } from "./sse.js";

export type OpenAICompatibleOptions = {
  providerName: string;
  apiKey?: string;
  apiKeyEnv: string;
  baseUrl: string;
  baseUrlEnv?: string;
  requiresApiKey: boolean;
};

type ChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: ChatCompletionUsage;
  error?: { message?: string; code?: string | number };
  message?: string;
};

type ChatCompletionStreamChunk = {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  usage?: ChatCompletionUsage;
  error?: { message?: string; code?: string | number };
  message?: string;
};

function getBaseUrl(options: OpenAICompatibleOptions): string {
  const baseUrl = options.baseUrlEnv ? process.env[options.baseUrlEnv] : undefined;
  return (baseUrl ?? options.baseUrl).replace(/\/+$/, "");
}

function getApiKey(config: RakitConfig, options: OpenAICompatibleOptions): string | undefined {
  const apiKey = config.apiKey ?? options.apiKey ?? process.env[options.apiKeyEnv];
  if (options.requiresApiKey && !apiKey) {
    throw new Error(`API key ${options.providerName} belum diset. Jalankan: rakit login atau rakit config set apiKey <${options.apiKeyEnv}>`);
  }
  return apiKey;
}

function getHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildProviderError(options: OpenAICompatibleOptions, status: number, statusText: string, data: ChatCompletionResponse | ChatCompletionStreamChunk): Error {
  const message = data.error?.message ?? data.message ?? statusText;
  const code = data.error?.code ? ` (${data.error.code})` : "";
  return new Error(`${options.providerName} error ${status}${code}: ${message}`);
}

function toUsage(usage: ChatCompletionUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const result: TokenUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

async function parseJsonResponse(response: Response): Promise<ChatCompletionResponse> {
  const raw = await response.text();
  try {
    return raw ? (JSON.parse(raw) as ChatCompletionResponse) : {};
  } catch {
    return { message: raw };
  }
}

export async function chatWithOpenAICompatible(
  messages: ChatMessage[],
  config: RakitConfig,
  options: OpenAICompatibleOptions,
): Promise<string> {
  const apiKey = getApiKey(config, options);
  const response = await fetch(`${getBaseUrl(options)}/chat/completions`, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
    }),
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw buildProviderError(options, response.status, response.statusText, data);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Response ${options.providerName} tidak berisi pesan assistant.`);
  }

  return content.trim();
}

export async function streamOpenAICompatible(
  messages: ChatMessage[],
  config: RakitConfig,
  options: OpenAICompatibleOptions,
  callbacks: { onToken?(token: string): void; onStatus?(message: string): void; onUsage?(usage: TokenUsage): void } = {},
): Promise<ProviderResponse> {
  const apiKey = getApiKey(config, options);
  callbacks.onStatus?.(`Menghubungi ${options.providerName}...`);

  const response = await fetch(`${getBaseUrl(options)}/chat/completions`, {
    method: "POST",
    headers: getHeaders(apiKey),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw buildProviderError(options, response.status, response.statusText, data);
  }

  let content = "";
  let usage: TokenUsage | undefined;

  for await (const chunk of parseSseJsonStream<ChatCompletionStreamChunk>(response)) {
    if (chunk.error) {
      const errCode = typeof chunk.error.code === "number" ? chunk.error.code : 500;
      throw buildProviderError(options, errCode, "stream error", chunk);
    }

    const chunkUsage = toUsage(chunk.usage);
    if (chunkUsage) {
      usage = chunkUsage;
      callbacks.onUsage?.(chunkUsage);
    }

    const token = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content ?? "";
    if (token) {
      content += token;
      callbacks.onToken?.(token);
    }
  }

  if (!content.trim()) {
    throw new Error(`Response ${options.providerName} tidak berisi pesan assistant.`);
  }

  return { content: content.trim(), usage };
}
