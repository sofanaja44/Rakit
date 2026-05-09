import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";

const DEFAULT_MAX_TOKENS = 16_000;

function getApiKey(config: RakitConfig): string {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("API key Anthropic belum diset. Jalankan: rakit1 login atau rakit1 config set apiKey <ANTHROPIC_API_KEY>");
  }
  return apiKey;
}

function splitMessages(messages: ChatMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  const system = messages.find((message) => message.role === "system")?.content;
  const chatMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: message.content }) as Anthropic.MessageParam);

  return { system, messages: chatMessages };
}

function toUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}

export async function chatWithAnthropic(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  const client = new Anthropic({ apiKey: getApiKey(config) });
  const request = splitMessages(messages);
  const response = await client.messages.create({
    model: config.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
  });

  const content = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!content) {
    throw new Error("Response Anthropic tidak berisi pesan assistant.");
  }

  return content;
}

export async function streamAnthropic(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: { onToken?(token: string): void; onStatus?(message: string): void; onUsage?(usage: TokenUsage): void } = {},
): Promise<ProviderResponse> {
  const client = new Anthropic({ apiKey: getApiKey(config) });
  const request = splitMessages(messages);
  callbacks.onStatus?.("Menghubungi Anthropic...");

  const stream = client.messages.stream({
    model: config.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
  });

  let content = "";
  const onText = (token: string) => {
    content += token;
    callbacks.onToken?.(token);
  };
  stream.on("text", onText);

  try {
    const finalMessage = await stream.finalMessage();
    callbacks.onUsage?.(toUsage(finalMessage.usage));

    if (!content.trim()) {
      content = finalMessage.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
    }

    if (!content.trim()) {
      throw new Error("Response Anthropic tidak berisi pesan assistant.");
    }

    return { content: content.trim(), usage: toUsage(finalMessage.usage) };
  } finally {
    stream.off("text", onText);
    stream.abort();
  }
}
