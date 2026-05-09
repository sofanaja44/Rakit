import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hasOpenAICodexCredentials } from "./auth.js";
import {
  ANTHROPIC_DEFAULT_MODEL,
  CONFIG_DIR,
  GEMINI_DEFAULT_MODEL,
  GROQ_DEFAULT_MODEL,
  OLLAMA_DEFAULT_MODEL,
  loadConfig,
  setConfigValue,
} from "./config.js";
import {
  fetchOpenRouterModels,
  isOpenRouterModelFree,
  type OpenRouterModel,
} from "./providers/openrouter.js";
import type { ProviderName } from "./types.js";
import { askYesNo, blank, code, icons, info, keyValue, line, muted, section, selectOption, success, ui, warn, withSpinner } from "./ui.js";

type QuestionFn = (query: string) => Promise<string>;

export type ModelSearchOptions = {
  search?: string;
  freeOnly?: boolean;
  limit?: number;
};

type ModelPickerOptions = {
  initialSearch?: string;
  defaultFreeOnly?: boolean;
  limit?: number;
};

type RakitModel = {
  id: string;
  provider: ProviderName;
  name?: string;
  description?: string;
  contextLength?: number;
  free?: boolean;
  label: "gratis" | "berbayar" | "subscription";
};

type LoadedModels = {
  provider: ProviderName;
  providerLabel: string;
  supportsFreeFilter: boolean;
  models: RakitModel[];
};

const DEFAULT_MODEL_LIMIT = 25;
const OPENROUTER_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OPENROUTER_MODELS_CACHE_FILE = path.join(CONFIG_DIR, "cache", "openrouter-models.json");
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const STATIC_PROVIDER_MODELS: Partial<Record<ProviderName, RakitModel[]>> = {
  anthropic: [
    { id: ANTHROPIC_DEFAULT_MODEL, provider: "anthropic", name: "Claude Opus 4.7", description: "Model Claude paling kuat untuk coding dan tugas agentic.", label: "berbayar" },
    { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6", description: "Model Opus generasi sebelumnya dengan konteks besar.", label: "berbayar" },
    { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet 4.6", description: "Model seimbang untuk kualitas dan kecepatan.", label: "berbayar" },
    { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", description: "Model cepat dan lebih hemat.", label: "berbayar" },
  ],
  gemini: [
    { id: GEMINI_DEFAULT_MODEL, provider: "gemini", name: "Gemini 2.5 Pro", description: "Model Gemini kualitas tinggi.", label: "berbayar" },
    { id: "gemini-2.5-flash", provider: "gemini", name: "Gemini 2.5 Flash", description: "Model Gemini cepat untuk tugas umum.", label: "berbayar" },
    { id: "gemini-2.0-flash", provider: "gemini", name: "Gemini 2.0 Flash", description: "Model Gemini Flash generasi 2.0.", label: "berbayar" },
  ],
  groq: [
    { id: GROQ_DEFAULT_MODEL, provider: "groq", name: "Llama 3.3 70B Versatile", description: "Model Llama besar lewat Groq.", label: "berbayar" },
    { id: "llama-3.1-8b-instant", provider: "groq", name: "Llama 3.1 8B Instant", description: "Model cepat lewat Groq.", label: "berbayar" },
    { id: "openai/gpt-oss-120b", provider: "groq", name: "GPT OSS 120B", description: "Model open-weight besar jika tersedia di Groq.", label: "berbayar" },
    { id: "openai/gpt-oss-20b", provider: "groq", name: "GPT OSS 20B", description: "Model open-weight ringan jika tersedia di Groq.", label: "berbayar" },
  ],
  ollama: [
    { id: OLLAMA_DEFAULT_MODEL, provider: "ollama", name: "Llama 3.2", description: "Model lokal default; pastikan sudah di-pull di Ollama.", label: "gratis" },
    { id: "llama3.1", provider: "ollama", name: "Llama 3.1", description: "Model lokal Llama 3.1.", label: "gratis" },
    { id: "qwen2.5-coder", provider: "ollama", name: "Qwen 2.5 Coder", description: "Model lokal untuk coding.", label: "gratis" },
    { id: "mistral", provider: "ollama", name: "Mistral", description: "Model lokal Mistral.", label: "gratis" },
  ],
};

const OPENAI_CODEX_MODELS: RakitModel[] = [
  {
    id: "gpt-5.1-codex-mini",
    provider: "openai-codex",
    name: "GPT-5.1 Codex Mini",
    description: "Model Codex ringan untuk coding cepat lewat subscription ChatGPT.",
    label: "subscription",
  },
  {
    id: "gpt-5-codex",
    provider: "openai-codex",
    name: "GPT-5 Codex",
    description: "Model Codex untuk tugas coding umum lewat subscription ChatGPT.",
    label: "subscription",
  },
  {
    id: "gpt-5.1-codex",
    provider: "openai-codex",
    name: "GPT-5.1 Codex",
    description: "Model Codex kualitas lebih tinggi untuk coding.",
    label: "subscription",
  },
  {
    id: "gpt-5.1-codex-max",
    provider: "openai-codex",
    name: "GPT-5.1 Codex Max",
    description: "Model Codex lebih kuat, biasanya memakai kuota lebih besar.",
    label: "subscription",
  },
  {
    id: "gpt-5.2-codex",
    provider: "openai-codex",
    name: "GPT-5.2 Codex",
    description: "Model Codex terbaru jika tersedia di akun kamu.",
    label: "subscription",
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai-codex",
    name: "GPT-5.3 Codex",
    description: "Model Codex terbaru jika tersedia di akun kamu.",
    label: "subscription",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit < 1) {
    return DEFAULT_MODEL_LIMIT;
  }

  return Math.min(Math.floor(limit), 100);
}

function normalizeSearch(search: string | undefined): string[] {
  return (search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function modelHaystack(model: RakitModel): string {
  return [model.id, model.name, model.description, model.provider]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function toRakitModel(model: OpenRouterModel): RakitModel {
  const free = isOpenRouterModelFree(model);

  return {
    id: model.id,
    provider: "openrouter",
    name: model.name,
    description: model.description,
    contextLength: model.context_length,
    free,
    label: free ? "gratis" : "berbayar",
  };
}

function getOpenRouterModelsCacheTtlMs(): number {
  const rawTtl = process.env.RAKIT_MODELS_CACHE_TTL_MS;

  if (rawTtl === undefined) {
    return OPENROUTER_MODELS_CACHE_TTL_MS;
  }

  const ttl = Number(rawTtl);
  if (!Number.isFinite(ttl) || ttl < 0) {
    return OPENROUTER_MODELS_CACHE_TTL_MS;
  }

  return Math.floor(ttl);
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Partial<OpenRouterModel>;
  return typeof model.id === "string" && model.id.length > 0;
}

async function readOpenRouterModelsCache(): Promise<OpenRouterModel[] | undefined> {
  const ttl = getOpenRouterModelsCacheTtlMs();
  if (ttl === 0) return undefined;

  try {
    const raw = await fs.readFile(OPENROUTER_MODELS_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { savedAt?: unknown; models?: unknown };

    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > ttl) {
      return undefined;
    }

    if (!Array.isArray(parsed.models)) {
      return undefined;
    }

    const models = parsed.models.filter(isOpenRouterModel);
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

async function writeOpenRouterModelsCache(models: OpenRouterModel[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(OPENROUTER_MODELS_CACHE_FILE), { recursive: true });
    await fs.writeFile(
      OPENROUTER_MODELS_CACHE_FILE,
      `${JSON.stringify({ savedAt: Date.now(), models }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Cache hanya optimasi; kegagalan tulis tidak boleh menggagalkan command.
  }
}

async function loadOpenRouterModels(config: { apiKey?: string }): Promise<OpenRouterModel[]> {
  const cachedModels = await readOpenRouterModelsCache();
  if (cachedModels) {
    return cachedModels;
  }

  const models = await fetchOpenRouterModels(config);
  await writeOpenRouterModelsCache(models);
  return models;
}

function formatModelMeta(model: RakitModel): string {
  const parts: string[] = [];

  if (model.name && model.name !== model.id) {
    parts.push(model.name);
  }

  if (typeof model.contextLength === "number") {
    parts.push(`ctx ${formatNumber(model.contextLength)}`);
  }

  const label = model.label === "gratis"
    ? ui.green("gratis")
    : model.label === "subscription"
      ? ui.magenta("subscription")
      : ui.yellow("berbayar");

  parts.push(label);

  return parts.join(` ${ui.dim("•")} `);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatPickerModelLabel(model: RakitModel, currentModel: string | undefined): string {
  const isActive = currentModel?.trim().toLowerCase() === model.id.toLowerCase();
  return isActive ? `${model.id}  (aktif)` : model.id;
}

function formatPickerModelHint(model: RakitModel, currentModel: string | undefined): string {
  const isActive = currentModel?.trim().toLowerCase() === model.id.toLowerCase();
  const meta = stripAnsi(formatModelMeta(model));
  return isActive ? `aktif sekarang • ${meta}` : meta;
}

function printModelResults(models: RakitModel[], totalCount: number): void {
  for (const [index, model] of models.entries()) {
    const num = ui.cyan(`${index + 1}.`.padEnd(4));
    const id = code(model.id);
    const meta = muted(formatModelMeta(model));
    line(`  ${num} ${id}`);
    line(`       ${meta}`);
  }

  if (totalCount > models.length) {
    blank();
    info(`Menampilkan ${models.length} dari ${totalCount} model. Persempit pencarian atau naikkan --limit.`);
  }
}

function getProviderLabel(provider: ProviderName): string {
  switch (provider) {
    case "openrouter":
      return "OpenRouter";
    case "openai-codex":
      return "OpenAI Codex";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    case "ollama":
      return "Ollama";
  }
}

// ── Data loading ───────────────────────────────────────────────────────

async function loadModelsFromActiveConfig(): Promise<LoadedModels> {
  const config = await loadConfig();

  if (config.provider === "openrouter") {
    if (!config.apiKey) {
      throw new Error("API key OpenRouter belum diset. Jalankan: rakit1 login");
    }

    const openRouterModels = await loadOpenRouterModels(config);
    return {
      provider: "openrouter",
      providerLabel: "OpenRouter",
      supportsFreeFilter: true,
      models: openRouterModels.map(toRakitModel),
    };
  }

  if (config.provider === "openai-codex") {
    if (!(await hasOpenAICodexCredentials())) {
      throw new Error("OpenAI Codex belum login. Jalankan: rakit1 login lalu pilih OpenAI Codex.");
    }

    return {
      provider: "openai-codex",
      providerLabel: "OpenAI Codex",
      supportsFreeFilter: false,
      models: OPENAI_CODEX_MODELS,
    };
  }

  const staticModels = STATIC_PROVIDER_MODELS[config.provider];
  if (staticModels) {
    return {
      provider: config.provider,
      providerLabel: getProviderLabel(config.provider),
      supportsFreeFilter: config.provider === "ollama",
      models: staticModels,
    };
  }

  throw new Error(`Provider ${config.provider} belum mendukung daftar model.`);
}

// ── Filtering & resolution ─────────────────────────────────────────────

function findModelById(models: RakitModel[], id: string): RakitModel | undefined {
  const normalizedId = id.trim().toLowerCase();
  return models.find((model) => model.id.toLowerCase() === normalizedId);
}

function resolveModelSelection(
  answer: string,
  shownModels: RakitModel[],
  allModels: RakitModel[],
): RakitModel | undefined {
  const value = answer.trim();
  const selectedNumber = Number(value);

  if (Number.isInteger(selectedNumber) && selectedNumber >= 1 && selectedNumber <= shownModels.length) {
    return shownModels[selectedNumber - 1];
  }

  return findModelById(allModels, value);
}


function filterModels(
  loaded: LoadedModels,
  options: ModelSearchOptions,
): RakitModel[] {
  const terms = normalizeSearch(options.search);
  const applyFreeFilter = loaded.supportsFreeFilter && options.freeOnly;

  const filtered = loaded.models
    .filter((model) => !applyFreeFilter || model.free)
    .filter((model) => {
      if (terms.length === 0) return true;
      const haystack = modelHaystack(model);
      return terms.every((term) => haystack.includes(term));
    });

  if (!loaded.supportsFreeFilter) {
    return filtered;
  }

  return filtered.sort((a, b) => {
    const freeDiff = Number(Boolean(b.free)) - Number(Boolean(a.free));
    return freeDiff || a.id.localeCompare(b.id);
  });
}

// ── Public: list models (non-interactive) ──────────────────────────────

export async function listModels(options: ModelSearchOptions): Promise<void> {
  const limit = normalizeLimit(options.limit);

  const loaded = await withSpinner("Mengambil daftar model provider aktif...", loadModelsFromActiveConfig());

  if (options.freeOnly && !loaded.supportsFreeFilter) {
    warn(`--free diabaikan untuk ${loaded.providerLabel}; provider ini tidak punya filter gratis/berbayar dinamis.`);
  }

  const filteredModels = filterModels(loaded, options);
  const shownModels = filteredModels.slice(0, limit);
  const searchText = options.search?.trim() ? ` untuk pencarian "${options.search.trim()}"` : "";
  const freeText = options.freeOnly && loaded.supportsFreeFilter ? " gratis" : "";

  blank();
  section(`${icons.ai} Model ${loaded.providerLabel}`);
  line(`  Ditemukan ${ui.bold(String(filteredModels.length))} model${freeText}${searchText}.`);
  blank();

  if (shownModels.length === 0) {
    warn("Tidak ada model yang cocok. Coba kata kunci lain.");
    return;
  }

  printModelResults(shownModels, filteredModels.length);
  blank();
  info(`Untuk memakai model tertentu: ${code("rakit1 config set model <model-id>")}`);
}

// ── Public: model picker (interactive) ─────────────────────────────────

export async function runModelPicker(
  question?: QuestionFn,
  options: ModelPickerOptions = {},
): Promise<string | undefined> {
  let ask = question;
  let close: (() => void) | undefined;
  const limit = normalizeLimit(options.limit);

  if (!ask) {
    const rl = readline.createInterface({ input, output });
    ask = (query: string) => rl.question(query);
    close = () => rl.close();
  }

  try {
    const activeConfig = await loadConfig();
    const loaded = await withSpinner("Mengambil daftar model provider aktif...", loadModelsFromActiveConfig());
    const currentModel = activeConfig.model;
    let freeOnly = loaded.supportsFreeFilter ? options.defaultFreeOnly ?? true : false;

    if (!loaded.supportsFreeFilter) {
      keyValue("provider", `${loaded.providerLabel} ${muted("(tanpa filter gratis dinamis)")}`);
    }

    let search = options.initialSearch?.trim() ?? "";

    while (true) {
      const usingTextFallback = !process.stdin.isTTY || !process.stdout.isTTY;
      if (usingTextFallback && !search) {
        search = (await ask(`${ui.yellow("?")} Cari model ${muted("(llama, qwen, gemini, codex; kosong untuk semua)")}: `)).trim();
      }

      const filteredModels = filterModels(loaded, { search, freeOnly });
      const shownModels = filteredModels.slice(0, limit);
      const searchText = search ? ` untuk "${search}"` : "";
      const freeText = freeOnly && loaded.supportsFreeFilter ? " gratis" : "";

      blank();
      section(`${icons.ai} Hasil model`);
      line(`  Ditemukan ${ui.bold(String(filteredModels.length))} model${freeText}${searchText}.`);
      blank();

      if (shownModels.length === 0) {
        const retry = await selectOption({
          message: "Tidak ada hasil. Cari lagi?",
          initialValue: "search",
          options: [
            { value: "search", label: "Cari ulang" },
            { value: "skip", label: "Skip" },
          ],
        });

        if (retry === "search") {
          search = "";
          continue;
        }

        const fallbackRetry = retry === undefined
          ? await askYesNo(ask, `${ui.yellow("?")} Tidak ada hasil. Cari lagi? ${muted("[Y/n]")}: `, true)
          : false;

        if (!fallbackRetry) return undefined;
        search = "";
        continue;
      }

      const navigationOptions = [
        { value: "__search", label: search ? "Ganti filter model" : "Cari / filter model", hint: search ? `filter sekarang: ${search}` : "ketik kata kunci" },
        ...(loaded.supportsFreeFilter
          ? [{ value: "__toggle_free", label: freeOnly ? "Tampilkan semua model" : "Tampilkan hanya gratis", hint: search ? "filter tetap dipertahankan" : undefined }]
          : []),
        { value: "__skip", label: "Skip", hint: "jangan ubah model" },
      ];

      const selected = await selectOption({
        message: "Pilih model",
        options: [
          ...navigationOptions,
          ...shownModels.map((model) => ({
            value: model.id,
            label: formatPickerModelLabel(model, currentModel),
            hint: formatPickerModelHint(model, currentModel),
          })),
        ],
      });

      if (selected === "__search") {
        search = "";
        continue;
      }

      if (selected === "__toggle_free") {
        freeOnly = !freeOnly;
        continue;
      }

      if (selected === "__skip") {
        return undefined;
      }

      if (selected) {
        const selectedModel = findModelById(loaded.models, selected);
        if (!selectedModel) {
          warn("Pilihan tidak ditemukan. Coba lagi.");
          blank();
          continue;
        }

        if (currentModel.trim().toLowerCase() === selectedModel.id.toLowerCase()) {
          blank();
          info(`Model sudah aktif: ${code(selectedModel.id)}`);
          return selectedModel.id;
        }

        await setConfigValue("model", selectedModel.id);
        blank();
        success(`Model aktif diset: ${code(selectedModel.id)}`);
        return selectedModel.id;
      }

      printModelResults(shownModels, filteredModels.length);

      if (loaded.supportsFreeFilter) {
        blank();
        info(`Ketik ${code("/cari")} untuk cari ulang, ${code("/free")} untuk hanya gratis, ${code("/all")} untuk semua model.`);
      } else {
        blank();
        info(`Ketik ${code("/cari")} untuk cari ulang.`);
      }

      const answer = (await ask(`${ui.yellow("?")} Pilih nomor/model id ${muted("(Enter untuk skip)")}: `)).trim();

      if (!answer) {
        return undefined;
      }

      const command = answer.toLowerCase();

      if (["/cari", "/search", "/ulang"].includes(command)) {
        search = "";
        continue;
      }

      if (loaded.supportsFreeFilter && command === "/free") {
        freeOnly = true;
        search = "";
        continue;
      }

      if (loaded.supportsFreeFilter && ["/all", "/semua"].includes(command)) {
        freeOnly = false;
        search = "";
        continue;
      }

      const selectedModel = resolveModelSelection(answer, shownModels, loaded.models);

      if (!selectedModel) {
        warn("Pilihan tidak ditemukan. Pilih nomor dari daftar atau paste model id lengkap.");
        blank();
        continue;
      }

      await setConfigValue("model", selectedModel.id);
      blank();
      success(`Model aktif diset: ${code(selectedModel.id)}`);
      return selectedModel.id;
    }
  } finally {
    close?.();
  }
}
