export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ProviderName = "openrouter" | "openai-codex" | "anthropic" | "gemini" | "groq" | "ollama";

export type RakitTheme = "rich" | "compact" | "minimal" | "no-footer";

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  contextLimit?: number;
};

export type ProviderResponse = {
  content: string;
  usage?: TokenUsage;
};

export type RakitConfig = {
  provider: ProviderName;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  theme: RakitTheme;
};
