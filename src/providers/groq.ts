import type { ChatMessage, ProviderResponse, RakitConfig } from "../types.js";
import { chatWithOpenAICompatible, streamOpenAICompatible } from "./openai-compatible.js";

const GROQ_OPTIONS = {
  providerName: "Groq",
  apiKeyEnv: "GROQ_API_KEY",
  baseUrl: "https://api.groq.com/openai/v1",
  requiresApiKey: true,
};

export function chatWithGroq(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  return chatWithOpenAICompatible(messages, config, GROQ_OPTIONS);
}

export function streamGroq(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: { onToken?(token: string): void; onStatus?(message: string): void; onUsage?(usage: ProviderResponse["usage"]): void } = {},
): Promise<ProviderResponse> {
  return streamOpenAICompatible(messages, config, GROQ_OPTIONS, callbacks);
}
