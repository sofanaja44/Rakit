import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";
import { parseSseJsonStream } from "./sse.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

type GeminiPart = { text?: string };
type GeminiContent = { role?: string; parts?: GeminiPart[] };
type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
type GeminiResponse = {
  candidates?: Array<{ content?: GeminiContent }>;
  usageMetadata?: GeminiUsage;
  error?: { message?: string; code?: number; status?: string };
};

type StreamCallbacks = {
  onToken?(token: string): void;
  onStatus?(message: string): void;
  onUsage?(usage: TokenUsage): void;
};

function getApiKey(config: RakitConfig): string {
  const apiKey = config.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("API key Gemini belum diset. Jalankan: rakit login atau rakit config set apiKey <GEMINI_API_KEY>");
  }
  return apiKey;
}

function toGeminiRole(role: ChatMessage["role"]): "user" | "model" {
  return role === "assistant" ? "model" : "user";
}

function buildGeminiBody(messages: ChatMessage[], config: RakitConfig): Record<string, unknown> {
  const system = messages.find((message) => message.role === "system")?.content;
  const contents = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: toGeminiRole(message.role), parts: [{ text: message.content }] }));

  return {
    contents,
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { temperature: config.temperature },
  };
}

function toUsage(usage: GeminiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
  };
}

function extractText(data: GeminiResponse): string {
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
}

function buildGeminiError(status: number, statusText: string, data: GeminiResponse): Error {
  const message = data.error?.message ?? statusText;
  const code = data.error?.status ?? data.error?.code;
  return new Error(`Gemini error ${status}${code ? ` (${code})` : ""}: ${message}`);
}

async function parseJsonResponse(response: Response): Promise<GeminiResponse> {
  const raw = await response.text();
  try {
    return raw ? (JSON.parse(raw) as GeminiResponse) : {};
  } catch {
    return { error: { message: raw } };
  }
}

export async function chatWithGemini(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  const apiKey = getApiKey(config);
  const response = await fetch(`${GEMINI_API_URL}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(messages, config)),
  });

  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw buildGeminiError(response.status, response.statusText, data);
  }

  const content = extractText(data);
  if (!content) {
    throw new Error("Response Gemini tidak berisi pesan assistant.");
  }

  return content;
}

export async function streamGemini(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: StreamCallbacks = {},
): Promise<ProviderResponse> {
  const apiKey = getApiKey(config);
  callbacks.onStatus?.("Menghubungi Gemini...");

  const response = await fetch(`${GEMINI_API_URL}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(messages, config)),
  });

  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw buildGeminiError(response.status, response.statusText, data);
  }

  let content = "";
  let usage: TokenUsage | undefined;

  for await (const chunk of parseSseJsonStream<GeminiResponse>(response)) {
    if (chunk.error) {
      const streamErrorStatus = typeof chunk.error.code === "number" ? chunk.error.code : 500;
      throw buildGeminiError(streamErrorStatus, chunk.error.status ?? "stream error", chunk);
    }

    const chunkUsage = toUsage(chunk.usageMetadata);
    if (chunkUsage) {
      usage = chunkUsage;
      callbacks.onUsage?.(chunkUsage);
    }

    const token = extractText(chunk);
    if (token) {
      content += token;
      callbacks.onToken?.(token);
    }
  }

  if (!content.trim()) {
    throw new Error("Response Gemini tidak berisi pesan assistant.");
  }

  return { content: content.trim(), usage };
}
