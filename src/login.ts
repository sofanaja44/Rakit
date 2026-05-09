import * as clack from "@clack/prompts";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getAuthPath, setOpenAICodexCredentials } from "./auth.js";
import { getConfigPath, loadConfig, setConfigValue } from "./config.js";
import { runModelPicker } from "./models.js";
import { loginOpenAICodex } from "./providers/openai-codex.js";
import type { ProviderName } from "./types.js";
import { askYesNo, blank, code, confirmSwitch, error as printError, formatError, icons, info, keyValue, line, muted, printLogo, section, selectOption, success, ui } from "./ui.js";

type QuestionFn = (query: string) => Promise<string>;

type ProviderKey = ProviderName | "openai";

type ProviderOption = {
  choice: string;
  key: ProviderKey;
  label: string;
  supported: boolean;
  note?: string;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  { choice: "1", key: "openrouter", label: "OpenRouter API Key", supported: true },
  { choice: "2", key: "openai-codex", label: "OpenAI Codex / ChatGPT Plus-Pro", supported: true },
  { choice: "3", key: "anthropic", label: "Anthropic API Key", supported: true },
  { choice: "4", key: "gemini", label: "Gemini API Key", supported: true },
  { choice: "5", key: "groq", label: "Groq API Key", supported: true },
  { choice: "6", key: "ollama", label: "Ollama Local", supported: true, note: "tanpa API key" },
  { choice: "7", key: "openai", label: "OpenAI API Key", supported: false, note: "segera" },
];

// ── Clack-based login wizard (standalone mode) ─────────────────────────

async function clackLoginWizard(): Promise<void> {
  blank();
  printLogo();
  blank();
  clack.intro(`${ui.cyan(ui.bold(icons.ai + " Login Rakit"))} ${ui.dim("— provider setup")}`);

  const supportedOptions = PROVIDER_OPTIONS.filter((o) => o.supported).map((o) => ({
    value: o.key,
    label: o.label,
    hint: ui.green("ready"),
  }));
  const unsupportedOptions = PROVIDER_OPTIONS.filter((o) => !o.supported).map((o) => ({
    value: o.key,
    label: `${o.label}`,
    hint: muted(o.note ?? "segera"),
  }));

  const providerChoice = await clack.select({
    message: "Pilih provider login",
    options: [...supportedOptions, ...unsupportedOptions],
  });

  if (clack.isCancel(providerChoice)) {
    clack.cancel("Login dibatalkan.");
    return;
  }

  const providerKey = providerChoice as ProviderKey;
  const provider = PROVIDER_OPTIONS.find((o) => o.key === providerKey);

  if (!provider || !provider.supported) {
    clack.cancel(`${provider?.label ?? providerKey} belum didukung di versi ini.`);
    return;
  }

  if (provider.key === "openrouter" || provider.key === "anthropic" || provider.key === "gemini" || provider.key === "groq" || provider.key === "ollama") {
    await clackLoginApiKeyProvider(provider);
  } else if (provider.key === "openai-codex") {
    await clackLoginCodex();
  }

  const shouldPickModel = await clack.confirm({
    message: "Mau cari dan pilih model sekarang?",
    initialValue: true,
  });

  if (clack.isCancel(shouldPickModel) || !shouldPickModel) {
    clack.outro("Login selesai!");
    return;
  }

  try {
    await runModelPicker(undefined, { defaultFreeOnly: provider.key === "openrouter" });
  } catch (error) {
    printError(`Gagal mengambil daftar model: ${formatError(error)}`);
    info(`Login tetap tersimpan. Coba lagi nanti dengan: ${code("rakit1 models --select")}`);
  }

  clack.outro("Login selesai! 🎉");
}

async function clackLoginApiKeyProvider(provider: ProviderOption): Promise<void> {
  const currentConfig = await loadConfig();

  if (currentConfig.apiKey) {
    clack.log.warn(`API key ${currentConfig.provider} lama akan diganti.`);
  }

  if (provider.key === "ollama") {
    await setConfigValue("provider", "ollama");
    clack.log.success("Provider Ollama disimpan.");
    clack.log.info(`${ui.dim("provider")}    Ollama`);
    clack.log.info(`${ui.dim("config")}      ${getConfigPath()}`);
    clack.log.info(`Default endpoint: ${code("http://localhost:11434/v1")}. Override dengan env OLLAMA_BASE_URL.`);
    return;
  }

  const apiKey = await clack.text({
    message: `Paste API key ${provider.label}`,
    placeholder: getProviderApiKeyPlaceholder(provider.key),
    validate(value) {
      if (!(value ?? "").trim()) return "API key tidak boleh kosong.";
    },
  });

  if (clack.isCancel(apiKey)) {
    clack.cancel("Login dibatalkan.");
    return;
  }

  await setConfigValue("provider", provider.key);
  await setConfigValue("apiKey", apiKey);

  clack.log.success("Login berhasil!");
  clack.log.info(`${ui.dim("provider")}    ${provider.label}`);
  clack.log.info(`${ui.dim("config")}      ${getConfigPath()}`);
}

async function clackLoginCodex(): Promise<void> {
  clack.log.info("Login OpenAI Codex membutuhkan akun ChatGPT Plus/Pro.");

  // For Codex OAuth flow we need a readline interface for the manual prompt
  const rl = readline.createInterface({ input, output });
  const question: QuestionFn = (query: string) => rl.question(query);

  try {
    const credentials = await loginOpenAICodex({
      onAuth({ url, instructions }) {
        blank();
        section("Buka URL berikut untuk login OpenAI");
        line(code(url));
        blank();
        info(instructions);
      },
      onPrompt(prompt) {
        return question(prompt);
      },
      onProgress(message) {
        info(message);
      },
    });

    await setOpenAICodexCredentials(credentials);
    await setConfigValue("provider", "openai-codex");

    clack.log.success("Login berhasil!");
    clack.log.info(`${ui.dim("provider")}    OpenAI Codex`);
    clack.log.info(`${ui.dim("auth")}        ${getAuthPath()}`);
    clack.log.info(`${ui.dim("config")}      ${getConfigPath()}`);
  } finally {
    rl.close();
  }
}

// ── Chat-mode login (uses passed-in question function) ─────────────────

function printProviderMenu(): void {
  section("Pilih provider login");

  for (const option of PROVIDER_OPTIONS) {
    const status = option.supported ? ui.green("ready") : muted(option.note ?? "segera");
    line(`${ui.cyan(`${option.choice}.`.padEnd(4))} ${option.label} ${muted("—")} ${status}`);
  }

  blank();
}

function findProviderOption(rawChoice: string): ProviderOption | undefined {
  const choice = rawChoice.trim().toLowerCase();

  if (!choice) {
    return PROVIDER_OPTIONS[0];
  }

  return PROVIDER_OPTIONS.find((option) => {
    return option.choice === choice
      || option.key === choice
      || option.label.toLowerCase() === choice;
  });
}

async function askProvider(question: QuestionFn): Promise<ProviderOption> {
  while (true) {
    const answer = await question(`${ui.yellow("?")} Pilih provider ${muted("[1]")}: `);
    const option = findProviderOption(answer);

    if (!option) {
      clack.log.warn("Pilihan tidak dikenal. Masukkan nomor provider, contoh: 1");
      blank();
      continue;
    }

    if (!option.supported) {
      clack.log.warn(`${option.label} belum didukung di versi ini.`);
      blank();
      continue;
    }

    return option;
  }
}

function getProviderApiKeyPlaceholder(provider: ProviderKey): string {
  switch (provider) {
    case "openrouter":
      return "sk-or-v1-...";
    case "anthropic":
      return "sk-ant-...";
    case "gemini":
      return "AIza...";
    case "groq":
      return "gsk_...";
    default:
      return "API key";
  }
}

async function askApiKey(question: QuestionFn, providerLabel: string): Promise<string> {
  while (true) {
    const apiKey = (await question(`${ui.yellow("?")} Paste API key ${providerLabel}: `)).trim();

    if (!apiKey) {
      clack.log.warn("API key tidak boleh kosong. Coba paste lagi.");
      blank();
      continue;
    }

    return apiKey;
  }
}


async function chatModeLoginApiKeyProvider(question: QuestionFn, provider: ProviderOption): Promise<void> {
  const currentConfig = await loadConfig();

  if (currentConfig.apiKey) {
    clack.log.warn(`API key ${currentConfig.provider} lama akan diganti.`);
  }

  if (provider.key === "ollama") {
    await setConfigValue("provider", "ollama");
    blank();
    success("Provider Ollama disimpan.");
    keyValue("provider", "Ollama");
    keyValue("endpoint", "http://localhost:11434/v1");
    keyValue("config", getConfigPath());
    info(`Override endpoint dengan env: ${code("OLLAMA_BASE_URL=http://localhost:11434/v1")}`);
    return;
  }

  const apiKey = await askApiKey(question, provider.label);

  await setConfigValue("provider", provider.key);
  await setConfigValue("apiKey", apiKey);

  blank();
  success("Login berhasil.");
  keyValue("provider", provider.label);
  keyValue("config", getConfigPath());
}

async function chatModeLoginCodex(question: QuestionFn): Promise<void> {
  blank();
  info("Login OpenAI Codex membutuhkan akun ChatGPT Plus/Pro.");

  const credentials = await loginOpenAICodex({
    onAuth({ url, instructions }) {
      blank();
      section("Buka URL berikut untuk login OpenAI");
      line(code(url));
      blank();
      info(instructions);
    },
    onPrompt(prompt) {
      return question(prompt);
    },
    onProgress(message) {
      info(message);
    },
  });

  await setOpenAICodexCredentials(credentials);
  await setConfigValue("provider", "openai-codex");

  blank();
  success("Login berhasil.");
  keyValue("provider", "OpenAI Codex");
  keyValue("auth", getAuthPath());
  keyValue("config", getConfigPath());
}

// ── Main entry point ───────────────────────────────────────────────────

export async function runLoginWizard(question?: QuestionFn): Promise<void> {
  // If no question function provided, use the interactive clack wizard
  if (!question) {
    await clackLoginWizard();
    return;
  }

  // Chat-mode login (uses passed-in question function)
  try {
    clack.intro(`${ui.cyan(ui.bold("Login Rakit"))} ${ui.dim("— provider setup")}`);
    blank();

    const selectedProvider = await selectOption({
      message: "Pilih provider login",
      options: PROVIDER_OPTIONS.map((providerOption) => ({
        value: providerOption.choice,
        label: providerOption.label,
        hint: providerOption.supported ? providerOption.note ?? "ready" : providerOption.note ?? "segera",
      })),
    });
    const provider = selectedProvider
      ? PROVIDER_OPTIONS.find((providerOption) => providerOption.choice === selectedProvider) ?? await askProvider(question)
      : (printProviderMenu(), await askProvider(question));

    if (provider.key === "openrouter" || provider.key === "anthropic" || provider.key === "gemini" || provider.key === "groq" || provider.key === "ollama") {
      await chatModeLoginApiKeyProvider(question, provider);
    } else if (provider.key === "openai-codex") {
      await chatModeLoginCodex(question);
    } else {
      throw new Error(`${provider.label} belum didukung.`);
    }

    blank();
    const modelChoice = await confirmSwitch({
      message: "Mau cari dan pilih model sekarang?",
      defaultChoice: "accept",
    });
    const shouldPickModel = modelChoice === undefined
      ? await askYesNo(question, `${ui.yellow("?")} Mau cari dan pilih model sekarang? ${muted("[Y/n]")}: `, true)
      : modelChoice === "accept";

    if (shouldPickModel) {
      try {
        await runModelPicker(question, { defaultFreeOnly: provider.key === "openrouter" });
      } catch (error) {
        printError(`Gagal mengambil daftar model: ${formatError(error)}`);
        info(`Login tetap tersimpan. Coba lagi nanti dengan: ${code("rakit1 models --select")}`);
      }
    }
  } catch (errorValue) {
    printError(formatError(errorValue));
    blank();
  }
}
