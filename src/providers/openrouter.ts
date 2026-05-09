import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";
import { parseSseJsonStream } from "./sse.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

export type OpenRouterPricing = Record<string, string | number | null | undefined> & {
  prompt?: string | number | null;
  completion?: string | number | null;
  request?: string | number | null;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: OpenRouterPricing;
};

type OpenRouterError = {
  message?: string;
  code?: number | string;
};

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  total_cost?: number;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: OpenRouterUsage;
  error?: OpenRouterError;
  message?: string;
};

type OpenRouterStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
  usage?: OpenRouterUsage;
  error?: OpenRouterError;
  message?: string;
};

type StreamCallbacks = {
  onToken?(token: string): void;
  onStatus?(message: string): void;
  onUsage?(usage: TokenUsage): void;
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
  error?: OpenRouterError;
  message?: string;
};

function getOpenRouterHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/rakit-cli/rakit-cli",
    "X-Title": "Rakit CLI",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function buildOpenRouterError(status: number, statusText: string, data: { error?: OpenRouterError; message?: string }): Error {
  const message = data.error?.message ?? data.message ?? statusText;
  const code = data.error?.code ? ` (${data.error.code})` : "";

  if (status === 429) {
    return new Error(
      `OpenRouter error 429${code}: ${message}. Ini biasanya rate limit/quota dari model/provider. `
        + "Coba tunggu sebentar, pilih model lain dengan /models atau rakit1 models --select --free, "
        + "atau pakai model berbayar/isi credits OpenRouter.",
    );
  }

  if (status === 401 || status === 403) {
    return new Error(
      `OpenRouter error ${status}${code}: ${message}. Cek API key dengan rakit1 login.`,
    );
  }

  if (status === 402) {
    return new Error(
      `OpenRouter error 402${code}: ${message}. Credits/quota OpenRouter kemungkinan tidak cukup.`,
    );
  }

  return new Error(`OpenRouter error ${status}${code}: ${message}`);
}

function toTokenUsage(usage: OpenRouterUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;

  const result: TokenUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    costUsd: usage.total_cost ?? usage.cost,
  };

  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function parsePrice(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function isOpenRouterModelFree(model: OpenRouterModel): boolean {
  if (model.id.endsWith(":free")) {
    return true;
  }

  const promptPrice = parsePrice(model.pricing?.prompt);
  const completionPrice = parsePrice(model.pricing?.completion);
  const requestPrice = parsePrice(model.pricing?.request) ?? 0;

  return promptPrice === 0 && completionPrice === 0 && requestPrice === 0;
}

export async function fetchOpenRouterModels(config: Pick<RakitConfig, "apiKey">): Promise<OpenRouterModel[]> {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  const response = await fetch(`${OPENROUTER_API_URL}/models`, {
    method: "GET",
    headers: getOpenRouterHeaders(apiKey),
  });

  const raw = await response.text();
  let data: OpenRouterModelsResponse = {};

  try {
    data = raw ? (JSON.parse(raw) as OpenRouterModelsResponse) : {};
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    throw buildOpenRouterError(response.status, response.statusText, data);
  }

  if (!Array.isArray(data.data)) {
    throw new Error("Response daftar model OpenRouter tidak valid.");
  }

  return data.data.filter((model) => typeof model.id === "string" && model.id.length > 0);
}

export async function chatWithOpenRouter(
  messages: ChatMessage[],
  config: RakitConfig,
): Promise<string> {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "API key OpenRouter belum diset. Jalankan: rakit1 login atau rakit1 config set apiKey <OPENROUTER_API_KEY>",
    );
  }

  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: "POST",
    headers: getOpenRouterHeaders(apiKey),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
    }),
  });

  const raw = await response.text();
  let data: OpenRouterResponse = {};

  try {
    data = raw ? (JSON.parse(raw) as OpenRouterResponse) : {};
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    throw buildOpenRouterError(response.status, response.statusText, data);
  }

  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Response OpenRouter tidak berisi pesan assistant.");
  }

  return content.trim();
}

export async function streamOpenRouter(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: StreamCallbacks = {},
): Promise<ProviderResponse> {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "API key OpenRouter belum diset. Jalankan: rakit1 login atau rakit1 config set apiKey <OPENROUTER_API_KEY>",
    );
  }

  callbacks.onStatus?.("Menghubungi OpenRouter...");

  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: "POST",
    headers: getOpenRouterHeaders(apiKey),
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    let data: OpenRouterResponse = {};

    try {
      data = raw ? (JSON.parse(raw) as OpenRouterResponse) : {};
    } catch {
      data = { message: raw };
    }

    throw buildOpenRouterError(response.status, response.statusText, data);
  }

  callbacks.onStatus?.("Menerima respons live...");

  let content = "";
  let usage: TokenUsage | undefined;

  for await (const chunk of parseSseJsonStream<OpenRouterStreamChunk>(response)) {
    if (chunk.error) {
      const errCode = typeof chunk.error.code === "number" ? chunk.error.code : 500;
      throw buildOpenRouterError(errCode, "stream error", chunk);
    }

    const chunkUsage = toTokenUsage(chunk.usage);
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
    throw new Error("Response OpenRouter tidak berisi pesan assistant.");
  }

  return { content: content.trim(), usage };
}
