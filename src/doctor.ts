import { hasOpenAICodexCredentials, getAuthPath } from "./auth.js";
import { getConfigPath, loadConfig, redactConfig } from "./config.js";
import type { ProviderName, RakitConfig } from "./types.js";
import { blank, code, icons, isPinnedFooterSupported, keyValue, line, section, ui, VERSION } from "./ui.js";

function isNodeVersionSupported(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isInteger(major) && major >= 18;
}

function statusIcon(ok: boolean): string {
  return ok ? ui.green(icons.ok) : ui.yellow(icons.warn);
}

function yesNo(value: boolean): string {
  return value ? ui.green("yes") : ui.yellow("no");
}

function terminalSize(): string {
  const columns = process.stdout.columns ?? "?";
  const rows = process.stdout.rows ?? "?";
  return `${columns}x${rows}`;
}

type ProviderReadiness = {
  provider: ProviderName;
  label: string;
  ready: boolean;
  source: string;
};

function getProviderReadiness(config: RakitConfig, codexLoggedIn: boolean): ProviderReadiness[] {
  return [
    {
      provider: "openrouter",
      label: "OpenRouter",
      ready: Boolean((config.provider === "openrouter" ? config.apiKey : undefined) || process.env.OPENROUTER_API_KEY),
      source: process.env.OPENROUTER_API_KEY ? "env OPENROUTER_API_KEY" : "config apiKey",
    },
    {
      provider: "openai-codex",
      label: "OpenAI Codex",
      ready: codexLoggedIn,
      source: "auth OAuth",
    },
    {
      provider: "anthropic",
      label: "Anthropic",
      ready: Boolean((config.provider === "anthropic" ? config.apiKey : undefined) || process.env.ANTHROPIC_API_KEY),
      source: process.env.ANTHROPIC_API_KEY ? "env ANTHROPIC_API_KEY" : "config apiKey",
    },
    {
      provider: "gemini",
      label: "Gemini",
      ready: Boolean((config.provider === "gemini" ? config.apiKey : undefined) || process.env.GEMINI_API_KEY),
      source: process.env.GEMINI_API_KEY ? "env GEMINI_API_KEY" : "config apiKey",
    },
    {
      provider: "groq",
      label: "Groq",
      ready: Boolean((config.provider === "groq" ? config.apiKey : undefined) || process.env.GROQ_API_KEY),
      source: process.env.GROQ_API_KEY ? "env GROQ_API_KEY" : "config apiKey",
    },
    {
      provider: "ollama",
      label: "Ollama",
      ready: true,
      source: process.env.OLLAMA_BASE_URL ? "env OLLAMA_BASE_URL" : "local default endpoint",
    },
  ];
}

function getProviderSetupHint(provider: ProviderName): string {
  switch (provider) {
    case "openrouter":
      return `Set ${code("OPENROUTER_API_KEY")} atau jalankan ${code("rakit login")}.`;
    case "openai-codex":
      return `Jalankan ${code("rakit login")} lalu pilih OpenAI Codex untuk login OAuth.`;
    case "anthropic":
      return `Set ${code("ANTHROPIC_API_KEY")} atau jalankan ${code("rakit login")}.`;
    case "gemini":
      return `Set ${code("GEMINI_API_KEY")} atau jalankan ${code("rakit login")}.`;
    case "groq":
      return `Set ${code("GROQ_API_KEY")} atau jalankan ${code("rakit login")}.`;
    case "ollama":
      return `Pastikan Ollama berjalan di ${code(process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1")} atau set ${code("OLLAMA_BASE_URL")}.`;
  }
}

export async function runDoctor(): Promise<void> {
  const config = await loadConfig();
  const redacted = redactConfig(config);
  const codexLoggedIn = await hasOpenAICodexCredentials();
  const providerReadiness = getProviderReadiness(config, codexLoggedIn);
  const activeProvider = providerReadiness.find((provider) => provider.provider === config.provider);
  const activeProviderReady = Boolean(activeProvider?.ready);

  blank();
  section(`${icons.ai} Rakit doctor`);
  blank();

  keyValue("version", VERSION);
  keyValue("node", `${process.version} ${statusIcon(isNodeVersionSupported())}`);
  keyValue("platform", `${process.platform} ${process.arch}`);
  keyValue("cwd", process.cwd());
  blank();

  keyValue("provider", String(redacted.provider));
  keyValue("model", String(redacted.model));
  keyValue("apiKey", String(redacted.apiKey));
  keyValue("config", getConfigPath());
  keyValue("auth", getAuthPath());
  blank();

  for (const provider of providerReadiness) {
    const activeMarker = provider.provider === config.provider ? ui.dim(" active") : "";
    keyValue(provider.label.toLowerCase(), `${yesNo(provider.ready)} ${ui.dim(`(${provider.source})`)}${activeMarker}`);
  }
  keyValue("active ready", `${statusIcon(activeProviderReady)} ${activeProviderReady ? "ready" : "needs setup"}`);
  blank();

  keyValue("tty", yesNo(Boolean(process.stdout.isTTY)));
  keyValue("terminal", terminalSize());
  keyValue("pinned footer", yesNo(isPinnedFooterSupported()));
  blank();

  if (!activeProviderReady || config.provider === "ollama") {
    line(`  ${ui.dim(icons.info)} Setup ${activeProvider?.label ?? config.provider}: ${getProviderSetupHint(config.provider)}`);
  }

  if (!isPinnedFooterSupported()) {
    line(`  ${ui.dim(icons.info)} Footer pinned butuh terminal TTY dengan tinggi layar cukup.`);
  }

  blank();
}
