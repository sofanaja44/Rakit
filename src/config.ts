import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderName, RakitConfig, RakitTheme } from "./types.js";

// ── Default values ─────────────────────────────────────────────────────
export const OPENROUTER_DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct:free";
export const OPENAI_CODEX_DEFAULT_MODEL = "gpt-5.1-codex-mini";
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-7";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-pro";
export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const OLLAMA_DEFAULT_MODEL = "llama3.2";
export const DEFAULT_MODEL = OPENROUTER_DEFAULT_MODEL;

export const DEFAULT_SYSTEM_PROMPT = `Kamu adalah Rakit, AI coding assistant yang berjalan di terminal.
Jawab dengan ringkas, jelas, dan praktis.
Jika user meminta bantuan coding, berikan langkah konkret dan contoh kode yang bisa langsung dipakai.`;

export const CONFIG_DIR = path.join(os.homedir(), ".rakit");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DEFAULT_THEME: RakitTheme = "rich";

// ── Zod schema for config validation ───────────────────────────────────
const providerSchema = z.enum(["openrouter", "openai-codex", "anthropic", "gemini", "groq", "ollama"]).catch("openrouter");
const rawProviderSchema = z.enum(["openrouter", "openai-codex", "anthropic", "gemini", "groq", "ollama"]);
const themeSchema = z.enum(["rich", "compact", "minimal", "no-footer"]).catch(DEFAULT_THEME);
const rawThemeSchema = z.enum(["rich", "compact", "minimal", "no-footer"]);

const configSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().trim().min(1).optional().catch(undefined),
  model: z.string().trim().min(1).optional().catch(undefined),
  systemPrompt: z.string().min(1).optional().catch(undefined),
  temperature: z
    .number()
    .finite()
    .min(0)
    .max(2)
    .optional()
    .catch(undefined),
  theme: themeSchema.optional().catch(undefined),
}).catch({
  provider: "openrouter" as const,
  apiKey: undefined,
  model: undefined,
  systemPrompt: undefined,
  temperature: undefined,
  theme: undefined,
});

// ── Helpers ────────────────────────────────────────────────────────────

const CONFIG_KEYS = ["provider", "apiKey", "model", "systemPrompt", "temperature", "theme"] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

type NormalizeOptions = {
  useEnvApiKey: boolean;
};

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getDefaultConfig(): RakitConfig {
  return {
    provider: "openrouter",
    model: DEFAULT_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.7,
    theme: DEFAULT_THEME,
  };
}

export function getDefaultModelForProvider(provider: ProviderName): string {
  switch (provider) {
    case "openai-codex":
      return OPENAI_CODEX_DEFAULT_MODEL;
    case "anthropic":
      return ANTHROPIC_DEFAULT_MODEL;
    case "gemini":
      return GEMINI_DEFAULT_MODEL;
    case "groq":
      return GROQ_DEFAULT_MODEL;
    case "ollama":
      return OLLAMA_DEFAULT_MODEL;
    case "openrouter":
    default:
      return OPENROUTER_DEFAULT_MODEL;
  }
}

function getEnvApiKeyForProvider(provider: ProviderName): string | undefined {
  switch (provider) {
    case "openrouter":
      return process.env.OPENROUTER_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    case "groq":
      return process.env.GROQ_API_KEY;
    case "ollama":
      return process.env.OLLAMA_API_KEY;
    case "openai-codex":
      return undefined;
  }
}

// ── Read & parse stored config with zod ────────────────────────────────

async function readStoredConfig(): Promise<z.infer<typeof configSchema>> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // zod .catch() will fallback to defaults
      return configSchema.parse(null);
    }

    return configSchema.parse(parsed);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return configSchema.parse({});
    }

    if (error instanceof SyntaxError) {
      // Corrupt JSON — return safe defaults instead of crashing
      return configSchema.parse({});
    }

    throw error;
  }
}

// ── Normalize config (merge stored + defaults + env) ───────────────────

function normalizeConfig(stored: z.infer<typeof configSchema>, options: NormalizeOptions): RakitConfig {
  const defaults = getDefaultConfig();
  const provider = stored.provider;
  const envApiKey = options.useEnvApiKey ? getEnvApiKeyForProvider(provider) : undefined;

  return {
    provider,
    apiKey: envApiKey ?? stored.apiKey,
    model: stored.model ?? getDefaultModelForProvider(provider),
    systemPrompt: stored.systemPrompt ?? defaults.systemPrompt,
    temperature: stored.temperature ?? defaults.temperature,
    theme: stored.theme ?? defaults.theme,
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export async function loadConfig(): Promise<RakitConfig> {
  const stored = await readStoredConfig();
  return normalizeConfig(stored, { useEnvApiKey: true });
}

async function loadConfigForSaving(): Promise<RakitConfig> {
  const stored = await readStoredConfig();
  return normalizeConfig(stored, { useEnvApiKey: false });
}

export async function saveConfig(config: RakitConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(CONFIG_FILE, content, { encoding: "utf8", mode: 0o600 });

  try {
    await fs.chmod(CONFIG_FILE, 0o600);
  } catch {
    // Windows tidak selalu mendukung chmod seperti Unix. Aman untuk diabaikan.
  }
}

function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export async function setConfigValue(key: string, rawValue: string): Promise<RakitConfig> {
  if (!isConfigKey(key)) {
    throw new Error(`Key config tidak dikenal: ${key}. Key yang tersedia: ${CONFIG_KEYS.join(", ")}`);
  }

  const value = rawValue.trim();

  if (!value) {
    throw new Error("Value config tidak boleh kosong.");
  }

  const config = await loadConfigForSaving();

  switch (key) {
    case "provider": {
      const result = rawProviderSchema.safeParse(value);
      if (!result.success) {
        throw new Error("Provider yang didukung: openrouter, openai-codex, anthropic, gemini, groq, ollama");
      }
      config.provider = result.data;
      config.model = getDefaultModelForProvider(config.provider);
      break;
    }
    case "apiKey": {
      config.apiKey = value;
      break;
    }
    case "model": {
      config.model = value;
      break;
    }
    case "systemPrompt": {
      config.systemPrompt = rawValue;
      break;
    }
    case "temperature": {
      const temperature = Number(value);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new Error("temperature harus berupa angka antara 0 sampai 2.");
      }
      config.temperature = temperature;
      break;
    }
    case "theme": {
      const result = rawThemeSchema.safeParse(value);
      if (!result.success) {
        throw new Error("Theme yang didukung: rich, compact, minimal, no-footer");
      }
      config.theme = result.data;
      break;
    }
  }

  await saveConfig(config);
  return config;
}

// ── Redaction helpers ──────────────────────────────────────────────────

function maskApiKey(apiKey?: string): string {
  if (!apiKey) return "(belum diset)";
  if (apiKey.length <= 10) return "********";
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

export function redactConfig(config: RakitConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    apiKey: config.provider === "openai-codex" ? "(tidak dipakai untuk provider ini)" : maskApiKey(config.apiKey),
    model: config.model,
    temperature: config.temperature,
    theme: config.theme,
    systemPrompt: config.systemPrompt,
  };
}
