import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";
import { chatWithAnthropic, streamAnthropic } from "./anthropic.js";
import { chatWithGemini, streamGemini } from "./gemini.js";
import { chatWithGroq, streamGroq } from "./groq.js";
import { chatWithOllama, streamOllama } from "./ollama.js";
import { chatWithOpenAICodex, streamOpenAICodex } from "./openai-codex.js";
import { chatWithOpenRouter, streamOpenRouter } from "./openrouter.js";

export type StreamCallbacks = {
  onToken?(token: string): void;
  onStatus?(message: string): void;
  onUsage?(usage: TokenUsage): void;
};

export async function chatWithProvider(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  switch (config.provider) {
    case "openai-codex":
      return chatWithOpenAICodex(messages, config);
    case "openrouter":
      return chatWithOpenRouter(messages, config);
    case "anthropic":
      return chatWithAnthropic(messages, config);
    case "gemini":
      return chatWithGemini(messages, config);
    case "groq":
      return chatWithGroq(messages, config);
    case "ollama":
      return chatWithOllama(messages, config);
    default: {
      const neverProvider: never = config.provider;
      throw new Error(`Provider tidak didukung: ${neverProvider}`);
    }
  }
}

export async function streamWithProvider(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: StreamCallbacks = {},
): Promise<ProviderResponse> {
  switch (config.provider) {
    case "openai-codex":
      return streamOpenAICodex(messages, config, callbacks);
    case "openrouter":
      return streamOpenRouter(messages, config, callbacks);
    case "anthropic":
      return streamAnthropic(messages, config, callbacks);
    case "gemini":
      return streamGemini(messages, config, callbacks);
    case "groq":
      return streamGroq(messages, config, callbacks);
    case "ollama":
      return streamOllama(messages, config, callbacks);
    default: {
      const neverProvider: never = config.provider;
      throw new Error(`Provider tidak didukung: ${neverProvider}`);
    }
  }
}
