#!/usr/bin/env node
import { Command } from "commander";
import { askOnce, startInteractiveChat } from "./chat.js";
import { getConfigPath, loadConfig, redactConfig, setConfigValue } from "./config.js";
import { runDoctor } from "./doctor.js";
import { runLoginWizard } from "./login.js";
import { listModels, runModelPicker } from "./models.js";
import {
  blank,
  clack,
  code,
  error as printError,
  formatError,
  icons,
  keyValue,
  line,
  printLogo,
  success,
  ui,
  VERSION,
} from "./ui.js";

type ModelsCommandOptions = {
  free?: boolean;
  select?: boolean;
  limit?: string;
};

function parseLimitOption(rawLimit: string | undefined): number | undefined {
  if (rawLimit === undefined) {
    return undefined;
  }

  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit harus berupa angka bulat lebih dari 0.");
  }

  return limit;
}

const program = new Command();

program
  .name("rakit")
  .description("Rakit — CLI coding assistant berbasis OpenRouter dan OpenAI Codex")
  .version(VERSION)
  .argument("[prompt...]", "Prompt langsung untuk AI")
  .action(async (promptParts: string[]) => {
    if (promptParts.length > 0) {
      await askOnce(promptParts.join(" "));
      return;
    }

    await startInteractiveChat();
  });

program
  .command("chat")
  .description("Mulai mode chat interaktif")
  .action(async () => {
    await startInteractiveChat();
  });

program
  .command("tui")
  .description("Mulai mode chat dengan layout terminal penuh")
  .action(async () => {
    await startInteractiveChat({ tui: true });
  });

program
  .command("login")
  .description("Login provider lewat wizard (API key/OAuth)")
  .action(async () => {
    await runLoginWizard();
  });

const configCommand = program.command("config").description("Kelola konfigurasi Rakit");

configCommand
  .command("get")
  .description("Tampilkan konfigurasi aktif")
  .action(async () => {
    const config = await loadConfig();
    const redacted = redactConfig(config);

    blank();
    line(`  ${ui.cyan(icons.ai)} ${ui.bold(ui.cyan("Config Rakit"))}`);
    blank();

    const configBody = [
      `${ui.dim("path")}          ${getConfigPath()}`,
      `${ui.dim("provider")}      ${String(redacted.provider)}`,
      `${ui.dim("apiKey")}        ${String(redacted.apiKey)}`,
      `${ui.dim("model")}         ${String(redacted.model)}`,
      `${ui.dim("temperature")}   ${String(redacted.temperature)}`,
      `${ui.dim("theme")}         ${String(redacted.theme)}`,
      `${ui.dim("system")}        ${String(redacted.systemPrompt)}`,
    ].join("\n");

    clack.note(configBody, "Konfigurasi Aktif");
    line(`  ${ui.dim(icons.info)} Ubah dengan: ${code("rakit config set <key> <value>")}`);
    blank();
  });

configCommand
  .command("path")
  .description("Tampilkan lokasi file config")
  .action(() => {
    process.stdout.write(`${getConfigPath()}\n`);
  });

configCommand
  .command("set")
  .description("Set konfigurasi. Contoh: rakit config set apiKey sk-or-xxx")
  .argument("<key>", "provider | apiKey | model | systemPrompt | temperature | theme")
  .argument("<value...>", "Nilai config")
  .action(async (key: string, valueParts: string[]) => {
    const value = valueParts.join(" ");
    await setConfigValue(key, value);

    success(`Config disimpan: ${getConfigPath()}`);

    if (key === "apiKey") {
      success("apiKey berhasil diset.");
      return;
    }

    keyValue(key, value);
  });

program
  .command("models")
  .description("Cari daftar model provider aktif")
  .argument("[search...]", "Kata kunci pencarian model, contoh: llama qwen gemini codex")
  .option("-f, --free", "Tampilkan hanya model gratis")
  .option("-s, --select", "Pilih model dari hasil pencarian dan simpan ke config")
  .option("-l, --limit <number>", "Jumlah maksimal hasil yang ditampilkan", "25")
  .action(async (searchParts: string[], options: ModelsCommandOptions) => {
    const search = searchParts.join(" ");
    const limit = parseLimitOption(options.limit);

    if (options.select) {
      await runModelPicker(undefined, {
        initialSearch: search,
        defaultFreeOnly: options.free ?? true,
        limit,
      });
      return;
    }

    await listModels({
      search,
      freeOnly: options.free ?? false,
      limit,
    });
  });

program
  .command("doctor")
  .description("Cek environment, config, provider, dan terminal")
  .action(async () => {
    await runDoctor();
  });

program
  .command("about")
  .description("Tentang Rakit CLI")
  .action(() => {
    blank();
    printLogo();
    blank();
    line(`  ${ui.dim("Version")}       ${VERSION}`);
    line(`  ${ui.dim("License")}       MIT`);
    line(`  ${ui.dim("Runtime")}       Node.js ${process.version}`);
    line(`  ${ui.dim("Platform")}      ${process.platform} ${process.arch}`);
    blank();
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  printError(formatError(error));
  process.exit(1);
});
