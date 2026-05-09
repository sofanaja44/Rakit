import type { ChatMessage, ProviderResponse, RakitConfig } from "../types.js";
import { chatWithOpenAICompatible, streamOpenAICompatible } from "./openai-compatible.js";

const OLLAMA_OPTIONS = {
  providerName: "Ollama",
  apiKeyEnv: "OLLAMA_API_KEY",
  baseUrl: "http://localhost:11434/v1",
  baseUrlEnv: "OLLAMA_BASE_URL",
  requiresApiKey: false,
};

export function chatWithOllama(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  return chatWithOpenAICompatible(messages, config, OLLAMA_OPTIONS);
}

export function streamOllama(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: { onToken?(token: string): void; onStatus?(message: string): void; onUsage?(usage: ProviderResponse["usage"]): void } = {},
): Promise<ProviderResponse> {
  return streamOpenAICompatible(messages, config, OLLAMA_OPTIONS, callbacks);
}
