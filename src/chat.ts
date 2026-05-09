import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import {
  appendTextFile,
  buildPromptFileContext,
  buildRuntimeSystemPrompt,
  confirmAndApplyFileActions,
  deletePath,
  executeShellCommand,
  extractFileActions,
  findProjectFiles,
  inspectProject,
  isApprovalBoilerplateLine,
  listDirectory,
  listProjectTree,
  makeDirectory,
  readMultilineInput,
  readTextFile,
  writeTextFile,
} from "./files.js";
import { highlightCode, highlightFile } from "./markdown.js";
import { runLoginWizard } from "./login.js";
import { runModelPicker } from "./models.js";
import { streamWithProvider } from "./providers/index.js";
import { clearProjectSession, getProjectSessionSummary, loadProjectSession, saveProjectSession } from "./session.js";
import type { ChatMessage, RakitConfig, TokenUsage } from "./types.js";
import {
  blank,
  clack,
  code,
  compactHeader,
  createLiveStreamView,
  command as commandHelp,
  divider,
  error as printError,
  formatError,
  goodbye,
  icons,
  info,
  keyValue,
  line,
  muted,
  printResponseGate,
  promptLabel,
  resetPinnedFooter,
  section,
  startTuiFrame,
  stopTuiFrame,
  stripAnsi,
  updatePinnedFooter,
  updateTuiFrame,
  success,
  ui,
  warn,
  welcomeScreen,
} from "./ui.js";

type QuestionFn = (query: string) => Promise<string>;

type FileCommandResult = {
  handled: boolean;
  context?: string;
};

const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_MESSAGES_LIMIT = 200;

function getMaxHistoryMessages(): number {
  const rawValue = process.env.RAKIT_MAX_HISTORY_MESSAGES;

  if (rawValue === undefined) {
    return DEFAULT_MAX_HISTORY_MESSAGES;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    return DEFAULT_MAX_HISTORY_MESSAGES;
  }

  return Math.min(value, MAX_HISTORY_MESSAGES_LIMIT);
}

function getRequestMessages(messages: ChatMessage[]): ChatMessage[] {
  const maxHistoryMessages = getMaxHistoryMessages();
  if (maxHistoryMessages === 0 || messages.length <= maxHistoryMessages + 1) {
    return messages;
  }

  const [systemMessage, ...history] = messages;
  return [systemMessage, ...history.slice(-maxHistoryMessages)];
}

function trimStoredMessages(messages: ChatMessage[]): void {
  const maxHistoryMessages = getMaxHistoryMessages();
  if (maxHistoryMessages === 0) return;

  const removableCount = messages.length - 1 - maxHistoryMessages;
  if (removableCount > 0) {
    messages.splice(1, removableCount);
  }
}

function helpText(): string {
  return [
    "",
    `  ${ui.cyan(ui.bold("Perintah Chat"))}`,
    `  ${divider(36)}`,
    commandHelp("/help", "Tampilkan bantuan"),
    commandHelp("/login", "Login provider lewat wizard"),
    commandHelp("/models", "Cari dan pilih model provider aktif"),
    commandHelp("/model", "Tampilkan provider dan model aktif"),
    commandHelp("/session", "Tampilkan info session project"),
    commandHelp("/resume", "Load session project terakhir"),
    commandHelp("/save", "Simpan session sekarang"),
    commandHelp("/new", "Session baru dan hapus session tersimpan"),
    "",
    `  ${ui.cyan(ui.bold("Perintah File"))}`,
    `  ${divider(36)}`,
    commandHelp("/pwd", "Tampilkan folder kerja"),
    commandHelp("/ls", "Lihat isi folder. Contoh: /ls src"),
    commandHelp("/tree", "Lihat tree project. Contoh: /tree src"),
    commandHelp("/inspect", "Analisis tree + file penting"),
    commandHelp("/find", "Cari path/isi file. Contoh: /find login"),
    commandHelp("/read", "Baca file. Contoh: /read package.json"),
    commandHelp("/write", "Tulis/overwrite file"),
    commandHelp("/append", "Tambah isi file"),
    commandHelp("/edit", "Edit file dengan overwrite"),
    commandHelp("/mkdir", "Buat folder"),
    commandHelp("/delete", "Hapus file/folder"),
    commandHelp("/run", "Jalankan command setelah konfirmasi"),
    "",
    `  ${ui.cyan(ui.bold("Lainnya"))}`,
    `  ${divider(36)}`,
    commandHelp("/clear", "Hapus history percakapan"),
    commandHelp("/exit", "Keluar dari Rakit"),
    "",
    `  ${ui.bold("Tips")}`,
    `  ${icons.bullet} Minta AI langsung: ${code("buatkan todo app html css js")}`,
    `  ${icons.bullet} AI bisa membuat & edit file otomatis.`,
    "",
  ].join("\n");
}

function fileHelpText(): string {
  return [
    "",
    `  ${ui.cyan(ui.bold("Perintah File"))}`,
    `  ${divider(36)}`,
    commandHelp("/pwd", "Tampilkan folder kerja aktif"),
    commandHelp("/ls [path]", "Lihat isi folder"),
    commandHelp("/tree [path]", "Lihat tree folder project"),
    commandHelp("/inspect [path]", "Analisis tree + file penting"),
    commandHelp("/find <keyword>", "Cari path/isi file"),
    commandHelp("/read <path>", "Baca isi file teks"),
    commandHelp("/write <path>", "Tulis/overwrite file"),
    commandHelp("/append <path>", "Tambahkan teks ke akhir file"),
    commandHelp("/edit <path>", "Overwrite file dengan isi baru"),
    commandHelp("/mkdir <path>", "Buat folder"),
    commandHelp("/delete <path>", "Hapus file/folder setelah konfirmasi"),
    commandHelp("/run <command>", "Jalankan command setelah konfirmasi"),
    "",
    `  ${ui.bold("Tips")}`,
    `  ${icons.bullet} Minta AI langsung: ${code("buatkan project todo app")}`,
    `  ${icons.bullet} Kalau AI mengirim aksi file, Rakit minta konfirmasi dulu.`,
    "",
  ].join("\n");
}

async function withRuntimePrompt(config: RakitConfig): Promise<RakitConfig> {
  return {
    ...config,
    systemPrompt: await buildRuntimeSystemPrompt(config.systemPrompt),
  };
}

async function buildUserPromptContent(prompt: string): Promise<string> {
  try {
    const fileContext = await buildPromptFileContext(prompt);
    return fileContext ? `${prompt}\n\n${fileContext}` : prompt;
  } catch {
    return prompt;
  }
}

const DEFAULT_CONTEXT_LIMIT = 272_000;

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateUsage(messages: ChatMessage[], answer: string, actualUsage?: TokenUsage): TokenUsage {
  const inputTokens = actualUsage?.inputTokens ?? estimateTokens(messages.map((message) => message.content).join("\n"));
  const outputTokens = actualUsage?.outputTokens ?? estimateTokens(answer);

  return {
    inputTokens,
    outputTokens,
    totalTokens: actualUsage?.totalTokens ?? inputTokens + outputTokens,
    costUsd: actualUsage?.costUsd,
    contextLimit: actualUsage?.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
  };
}

type TokenFormatter = {
  onToken(token: string): void;
  flush(): void;
};

function createActionTagFilter(onVisibleToken: (token: string) => void): TokenFormatter {
  let buffer = "";
  let skippingUntil: string | undefined;
  let hasVisibleOutput = false;

  const actionPrefix = "<rakit_";

  const emitVisible = (token: string): void => {
    const visibleToken = hasVisibleOutput ? token : token.replace(/^\s+/, "");
    if (!visibleToken) return;
    hasVisibleOutput = true;
    onVisibleToken(visibleToken);
  };

  const getPartialPrefixLength = (text: string): number => {
    const lower = text.toLowerCase();
    const maxLength = Math.min(actionPrefix.length - 1, lower.length);

    for (let length = maxLength; length > 0; length--) {
      if (actionPrefix.startsWith(lower.slice(-length))) return length;
    }

    return 0;
  };

  const processBuffer = (flushAll: boolean): void => {
    while (buffer) {
      const lowerBuffer = buffer.toLowerCase();

      if (skippingUntil) {
        const closeIndex = lowerBuffer.indexOf(skippingUntil);

        if (closeIndex === -1) {
          const keepLength = Math.max(0, skippingUntil.length - 1);
          buffer = buffer.length > keepLength ? buffer.slice(-keepLength) : buffer;
          return;
        }

        buffer = buffer.slice(closeIndex + skippingUntil.length);
        skippingUntil = undefined;
        continue;
      }

      const tagIndex = lowerBuffer.indexOf(actionPrefix);

      if (tagIndex === -1) {
        if (flushAll) {
          emitVisible(buffer);
          buffer = "";
          return;
        }

        const keepLength = getPartialPrefixLength(buffer);
        const visible = keepLength > 0 ? buffer.slice(0, -keepLength) : buffer;
        if (visible) emitVisible(visible);
        buffer = keepLength > 0 ? buffer.slice(-keepLength) : "";
        return;
      }

      if (tagIndex > 0) {
        emitVisible(buffer.slice(0, tagIndex));
        buffer = buffer.slice(tagIndex);
        continue;
      }

      const openMatch = buffer.match(/^<rakit_(file|patch|command|delete|mkdir)\b/i);
      if (!openMatch) {
        if (!flushAll && buffer.length < "<rakit_command".length) return;
        emitVisible(buffer[0]);
        buffer = buffer.slice(1);
        continue;
      }

      const tagEndIndex = buffer.indexOf(">");
      if (tagEndIndex === -1) {
        if (flushAll) buffer = "";
        return;
      }

      const kind = openMatch[1].toLowerCase();
      buffer = buffer.slice(tagEndIndex + 1);

      if (["file", "patch", "command"].includes(kind)) {
        skippingUntil = `</rakit_${kind}>`;
      }
    }
  };

  return {
    onToken(token: string): void {
      if (!token) return;
      buffer += token;
      processBuffer(false);
    },
    flush(): void {
      processBuffer(true);
    },
  };
}


function createBoilerplateLineFilter(onVisibleToken: (token: string) => void): TokenFormatter {
  let buffer = "";

  const emitLine = (lineText: string, newline = ""): void => {
    if (isApprovalBoilerplateLine(lineText)) return;
    onVisibleToken(`${lineText}${newline}`);
  };

  const processBuffer = (flushAll: boolean): void => {
    let newlineIndex = buffer.search(/\r\n|\n|\r/);

    while (newlineIndex !== -1) {
      const newlineMatch = buffer.slice(newlineIndex).match(/^(\r\n|\n|\r)/);
      const newline = newlineMatch?.[0] ?? "\n";
      emitLine(buffer.slice(0, newlineIndex), newline);
      buffer = buffer.slice(newlineIndex + newline.length);
      newlineIndex = buffer.search(/\r\n|\n|\r/);
    }

    if (flushAll && buffer) {
      emitLine(buffer);
      buffer = "";
    }
  };

  return {
    onToken(token: string): void {
      if (!token) return;
      buffer += token;
      processBuffer(false);
    },
    flush(): void {
      processBuffer(true);
    },
  };
}

function createCodeAwareTokenFormatter(onFormattedToken: (token: string) => void): TokenFormatter {
  let outsideBuffer = "";
  let codeBuffer = "";
  let inCodeBlock = false;
  let codeLanguage: string | undefined;

  const isLikelyCodeLine = (lineText: string): boolean => {
    const trimmed = lineText.trim();
    if (!trimmed) return false;
    if (/^(import|export|const|let|var|function|class|interface|type|enum|return|if|else|for|while|switch|case|try|catch|async|await)\b/.test(trimmed)) return true;
    if (/^(npm|pnpm|yarn|node|python|pip|git|docker|npx)\s+/.test(trimmed)) return true;
    if (/^[{}()[\];,.<>/]+$/.test(trimmed)) return true;
    if (/[{};=<>]/.test(trimmed) && !/[.!?]$/.test(trimmed)) return true;
    return false;
  };

  const emitOutside = (text: string) => {
    if (!text) return;
    const parts = text.split(/(\r\n|\n|\r)/);

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!part) continue;

      if (part === "\n" || part === "\r" || part === "\r\n") {
        onFormattedToken(part);
        continue;
      }

      const nextPart = parts[index + 1];
      const isCompleteLine = nextPart === "\n" || nextPart === "\r" || nextPart === "\r\n";
      onFormattedToken(isCompleteLine && isLikelyCodeLine(part) ? highlightCode(part) : part);
    }
  };

  const emitCodeLine = (lineText: string, newline = "") => {
    if (lineText.trimStart().startsWith("```")) {
      inCodeBlock = false;
      codeLanguage = undefined;
      onFormattedToken(`${ui.dim(lineText)}${newline}`);
      return;
    }

    onFormattedToken(`${highlightCode(lineText || " ", codeLanguage)}${newline}`);
  };

  const processCodeBuffer = () => {
    let newlineIndex = codeBuffer.search(/\r\n|\n|\r/);

    while (newlineIndex !== -1) {
      const newlineMatch = codeBuffer.slice(newlineIndex).match(/^(\r\n|\n|\r)/);
      const newline = newlineMatch?.[0] ?? "\n";
      const lineText = codeBuffer.slice(0, newlineIndex);
      codeBuffer = codeBuffer.slice(newlineIndex + newline.length);
      emitCodeLine(lineText, newline);

      if (!inCodeBlock) {
        outsideBuffer += codeBuffer;
        codeBuffer = "";
        processOutsideBuffer(false);
        return;
      }

      newlineIndex = codeBuffer.search(/\r\n|\n|\r/);
    }
  };

  function processOutsideBuffer(flushAll: boolean): void {
    while (true) {
      const fenceIndex = outsideBuffer.indexOf("```");

      if (fenceIndex === -1) {
        if (flushAll) {
          emitOutside(outsideBuffer);
          outsideBuffer = "";
          return;
        }

        const newlineIndex = outsideBuffer.search(/\r\n|\n|\r/);
        if (newlineIndex !== -1) {
          const newlineMatch = outsideBuffer.slice(newlineIndex).match(/^(\r\n|\n|\r)/);
          const newline = newlineMatch?.[0] ?? "\n";
          emitOutside(outsideBuffer.slice(0, newlineIndex + newline.length));
          outsideBuffer = outsideBuffer.slice(newlineIndex + newline.length);
          continue;
        }

        if (outsideBuffer.length > 160) {
          emitOutside(outsideBuffer.slice(0, -2));
          outsideBuffer = outsideBuffer.slice(-2);
        }
        return;
      }

      emitOutside(outsideBuffer.slice(0, fenceIndex));
      outsideBuffer = outsideBuffer.slice(fenceIndex);
      const newlineIndex = outsideBuffer.search(/\r\n|\n|\r/);

      if (newlineIndex === -1) {
        if (flushAll) {
          emitOutside(outsideBuffer);
          outsideBuffer = "";
        }
        return;
      }

      const newlineMatch = outsideBuffer.slice(newlineIndex).match(/^(\r\n|\n|\r)/);
      const newline = newlineMatch?.[0] ?? "\n";
      const fenceLine = outsideBuffer.slice(0, newlineIndex);
      codeLanguage = fenceLine.slice(3).trim() || undefined;
      inCodeBlock = true;
      onFormattedToken(`${ui.dim(fenceLine)}${newline}`);
      outsideBuffer = outsideBuffer.slice(newlineIndex + newline.length);
      codeBuffer += outsideBuffer;
      outsideBuffer = "";
      processCodeBuffer();

      if (inCodeBlock) return;
    }
  }

  return {
    onToken(token: string): void {
      if (!token) return;

      if (inCodeBlock) {
        codeBuffer += token;
        processCodeBuffer();
        return;
      }

      outsideBuffer += token;
      processOutsideBuffer(false);
    },
    flush(): void {
      if (inCodeBlock && codeBuffer) {
        emitCodeLine(codeBuffer);
        codeBuffer = "";
      }

      if (outsideBuffer) {
        processOutsideBuffer(true);
      }
    },
  };
}

async function runLiveAssistant(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  const initialUsage = estimateUsage(messages, "");
  const live = createLiveStreamView({ title: "Rakit", model: config.model, initialUsage, theme: config.theme });

  try {
    let actualUsage: TokenUsage | undefined;
    let partialAnswer = "";
    const tokenFormatter = createCodeAwareTokenFormatter((token) => live.onToken(token));
    const boilerplateFilter = createBoilerplateLineFilter((token) => tokenFormatter.onToken(token));
    const actionFilter = createActionTagFilter((token) => boilerplateFilter.onToken(token));
    const response = await streamWithProvider(messages, config, {
      onToken: (token) => {
        partialAnswer += token;
        actionFilter.onToken(token);
        live.updateUsage(estimateUsage(messages, partialAnswer, actualUsage));
      },
      onStatus: (message) => live.onStatus(message),
      onUsage: (nextUsage) => {
        actualUsage = nextUsage;
        live.updateUsage(estimateUsage(messages, partialAnswer, actualUsage));
      },
    });
    actionFilter.flush();
    boilerplateFilter.flush();
    tokenFormatter.flush();
    const finalUsage = estimateUsage(messages, response.content, response.usage ?? actualUsage);
    live.end({ usage: finalUsage });
    return response.content;
  } catch (errorValue) {
    live.end({ status: "error" });
    throw errorValue;
  }
}

async function printAssistantAnswer(
  answer: string,
  question?: QuestionFn,
  options: { textAlreadyPrinted?: boolean } = {},
): Promise<string> {
  const { displayText, actions } = extractFileActions(answer);
  const assistantText = displayText || (actions.length > 0 ? "Rakit menyiapkan aksi." : answer.trim());

  if (assistantText && !options.textAlreadyPrinted) {
    printResponseGate("Rakit", assistantText);
  }

  if (actions.length > 0) {
    if (question) {
      await confirmAndApplyFileActions(actions, question);
    } else {
      blank();
      warn("Ada aksi dari AI, tapi Rakit tidak bisa meminta konfirmasi di mode non-interaktif.");
      info("Jalankan di mode chat interaktif untuk menerapkan perubahan.");
    }
  }

  return assistantText;
}

async function askForDirectPromptApproval(actionsQuestion: (query: string) => Promise<string>): Promise<QuestionFn> {
  return actionsQuestion;
}

function getCommandArg(prompt: string, command: string): string {
  return prompt.slice(command.length).trim();
}

function requireArg(arg: string, usage: string): string | undefined {
  if (arg) return arg;
  warn(`Usage: ${code(usage)}`);
  blank();
  return undefined;
}


function buildCommandContext(commandText: string, outputText: string): string {
  return [
    "[KONTEKS OTOMATIS RAKIT]",
    `User menjalankan command CLI: ${commandText}`,
    "Output command sudah tersedia di bawah. Jangan minta user paste ulang output ini.",
    "Gunakan konteks ini untuk analisis/edit berikutnya.",
    "",
    stripAnsi(outputText).trim(),
  ].join("\n").trim();
}

function handledResult(context?: string): FileCommandResult {
  return { handled: true, context };
}

async function handleFileCommand(prompt: string, question: QuestionFn): Promise<FileCommandResult> {
  const command = prompt.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

  try {
    switch (command) {
      case "/files": {
        line(fileHelpText());
        return handledResult();
      }
      case "/pwd": {
        const outputText = `folder: ${process.cwd()}`;
        keyValue("folder", process.cwd());
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/ls": {
        const arg = getCommandArg(prompt, command) || ".";
        const outputText = await listDirectory(arg);
        line(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/tree": {
        const arg = getCommandArg(prompt, command) || ".";
        const outputText = await listProjectTree(arg);
        line(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/inspect": {
        const arg = getCommandArg(prompt, command) || ".";
        const outputText = await inspectProject(arg);
        line(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/find":
      case "/search": {
        const arg = requireArg(getCommandArg(prompt, command), `${command} <keyword>`);
        if (!arg) return handledResult();
        const outputText = await findProjectFiles(arg);
        line(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/read": {
        const arg = requireArg(getCommandArg(prompt, command), "/read <path>");
        if (!arg) return handledResult();
        section(`${icons.file} ${arg}`);
        const content = await readTextFile(arg);
        line(highlightFile(content, arg));
        blank();
        return handledResult(buildCommandContext(prompt, `${arg}\n${content}`));
      }
      case "/mkdir": {
        const arg = requireArg(getCommandArg(prompt, command), "/mkdir <path>");
        if (!arg) return handledResult();
        const outputText = await makeDirectory(arg);
        success(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/write":
      case "/edit": {
        const arg = requireArg(getCommandArg(prompt, command), `${command} <path>`);
        if (!arg) return handledResult();

        if (command === "/edit") {
          warn("Mode edit akan menimpa isi file dengan isi baru.");
        }

        const content = await readMultilineInput(question);
        if (content === undefined) {
          warn("Dibatalkan.");
          blank();
          return handledResult();
        }

        const outputText = await writeTextFile(arg, content);
        success(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, `${outputText}\n${arg}\n${content}`));
      }
      case "/append": {
        const arg = requireArg(getCommandArg(prompt, command), "/append <path>");
        if (!arg) return handledResult();
        const content = await readMultilineInput(question);
        if (content === undefined) {
          warn("Dibatalkan.");
          blank();
          return handledResult();
        }

        const outputText = await appendTextFile(arg, content);
        success(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, `${outputText}\n${arg}\n${content}`));
      }
      case "/delete": {
        const arg = requireArg(getCommandArg(prompt, command), "/delete <path>");
        if (!arg) return handledResult();
        const answer = (await question(`${ui.yellow("?")} Yakin hapus ${code(arg)}? ${muted("[y/N]")}: `)).trim().toLowerCase();

        if (!["y", "yes", "ya", "iya"].includes(answer)) {
          warn("Dibatalkan.");
          blank();
          return handledResult();
        }

        const outputText = await deletePath(arg);
        success(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      case "/run": {
        const arg = requireArg(getCommandArg(prompt, command), "/run <command>");
        if (!arg) return handledResult();
        const answer = (await question(`${ui.yellow("?")} Jalankan ${code(arg)}? ${muted("[y/N]")}: `)).trim().toLowerCase();

        if (!["y", "yes", "ya", "iya"].includes(answer)) {
          warn("Dibatalkan.");
          blank();
          return handledResult();
        }

        const outputText = await executeShellCommand(arg);
        success(outputText);
        blank();
        return handledResult(buildCommandContext(prompt, outputText));
      }
      default:
        return { handled: false };
    }
  } catch (errorValue) {
    printError(formatError(errorValue));
    blank();
    return handledResult();
  }
}

async function runCommandPalette(): Promise<string | undefined> {
  blank();
  const category = await clack.select({
    message: "Menu Interaktif Rakit",
    options: [
      { value: "ask", label: "💬 Tanya AI" },
      { value: "files", label: "📁 Operasi File" },
      { value: "config", label: "⚙️ Pengaturan" },
      { value: "clear", label: "🧹 Hapus Percakapan" },
      { value: "exit", label: "❌ Keluar" },
    ],
  });

  if (clack.isCancel(category)) return undefined;

  switch (category) {
    case "ask": {
      const prompt = await clack.text({
        message: "Masukkan prompt untuk AI:",
        placeholder: "Buatkan todo app html css js...",
      });
      return clack.isCancel(prompt) || !prompt.trim() ? undefined : prompt;
    }
    case "files": {
      const action = await clack.select({
        message: "Pilih Operasi File",
        options: [
          { value: "/ls", label: "/ls     (Lihat isi folder)" },
          { value: "/tree", label: "/tree   (Lihat tree project)" },
          { value: "/inspect", label: "/inspect(Analisis project otomatis)" },
          { value: "/find", label: "/find   (Cari path/isi file)" },
          { value: "/pwd", label: "/pwd    (Tampilkan folder aktif)" },
          { value: "/read", label: "/read   (Baca file)" },
          { value: "/write", label: "/write  (Tulis file baru)" },
          { value: "/edit", label: "/edit   (Edit file)" },
          { value: "/append", label: "/append (Tambah isi file)" },
          { value: "/mkdir", label: "/mkdir  (Buat folder)" },
          { value: "/delete", label: "/delete (Hapus file/folder)" },
          { value: "/run", label: "/run    (Jalankan command)" },
        ],
      });
      if (clack.isCancel(action)) return undefined;
      
      if (["/pwd", "/ls", "/tree", "/inspect"].includes(action)) return action;

      const pathArg = await clack.text({
        message: action === "/run" ? "Masukkan command:" : action === "/find" ? "Masukkan keyword:" : `Masukkan path untuk ${action}:`,
        placeholder: action === "/run" ? "npm test" : action === "/find" ? "config" : "src/index.ts",
      });
      return clack.isCancel(pathArg) || !pathArg.trim() ? undefined : `${action} ${pathArg.trim()}`;
    }
    case "config": {
      const action = await clack.select({
        message: "Pilih Pengaturan",
        options: [
          { value: "/model", label: "Lihat Model Aktif" },
          { value: "/models", label: "Pilih Model" },
          { value: "/login", label: "Login Provider" },
        ],
      });
      return clack.isCancel(action) ? undefined : action;
    }
    case "clear":
      return "/clear";
    case "exit":
      return "/exit";
  }
  return undefined;
}

export async function askOnce(prompt: string): Promise<void> {
  const config = await loadConfig();
  const runtimeConfig = await withRuntimePrompt(config);
  const messages: ChatMessage[] = [
    { role: "system", content: runtimeConfig.systemPrompt },
    { role: "user", content: await buildUserPromptContent(prompt) },
  ];

  compactHeader(runtimeConfig.provider, runtimeConfig.model);

  const answer = await runLiveAssistant(messages, runtimeConfig);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    try {
      const question = await askForDirectPromptApproval((query) => rl.question(query));
      await printAssistantAnswer(answer, question, { textAlreadyPrinted: true });
    } finally {
      rl.close();
    }
    return;
  }

  await printAssistantAnswer(answer, undefined, { textAlreadyPrinted: true });
}

export async function startInteractiveChat(options: { tui?: boolean } = {}): Promise<void> {
  let config = await loadConfig();
  let runtimeConfig = await withRuntimePrompt(config);
  const messages: ChatMessage[] = [{ role: "system", content: runtimeConfig.systemPrompt }];
  
  let rl!: readline.Interface;
  let isInputClosed = false;
  let closePromise!: Promise<undefined>;
  let askLine!: (query: string) => Promise<string | undefined>;
  let question!: QuestionFn;

  const initRl = (preserveHistory?: string[]) => {
    rl = readline.createInterface({ input, output });
    isInputClosed = false;
    closePromise = new Promise<undefined>((resolve) => {
      rl.once("close", () => {
        isInputClosed = true;
        resolve(undefined);
      });
    });
    askLine = async (query: string): Promise<string | undefined> => {
      if (isInputClosed) return undefined;
      return Promise.race([rl.question(query), closePromise]);
    };
    question = async (query) => (await askLine(query)) ?? "";
    
    if (preserveHistory && Array.isArray((rl as any).history)) {
      (rl as any).history = preserveHistory;
    }
  };

  initRl();

  // ── Welcome screen with logo ──────────────────────────────────────
  const initialFooterUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextLimit: DEFAULT_CONTEXT_LIMIT };
  const tuiActive = options.tui && startTuiFrame({
    provider: runtimeConfig.provider,
    model: runtimeConfig.model,
    folder: process.cwd(),
    theme: runtimeConfig.theme,
    usage: initialFooterUsage,
  });

  if (!tuiActive) {
    welcomeScreen({
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      folder: process.cwd(),
    });
    if (runtimeConfig.theme !== "no-footer") {
      updatePinnedFooter({
        model: runtimeConfig.model,
        theme: runtimeConfig.theme,
        usage: initialFooterUsage,
      });
    }
  }

  const sessionSummary = await getProjectSessionSummary();
  if (sessionSummary.exists) {
    info(`Session project tersedia (${sessionSummary.messageCount ?? 0} pesan). Load dengan ${code("/resume")}.`);
    blank();
  }

  try {
    while (true) {
      if (runtimeConfig.theme !== "no-footer") updatePinnedFooter();
      const lineInput = await askLine(promptLabel());
      if (runtimeConfig.theme !== "no-footer") updatePinnedFooter();

      if (lineInput === undefined) {
        break;
      }

      let prompt = lineInput.trim();

      if (!prompt) continue;

      if (prompt === "/" || prompt === "/menu") {
        const history = (rl as any).history?.slice() || [];
        rl.close();

        const palettePrompt = await runCommandPalette();
        
        initRl(history);

        if (!palettePrompt) {
          warn("Menu dibatalkan.");
          blank();
          continue;
        }
        prompt = palettePrompt;
      }

      const command = prompt.toLowerCase();

      if (["/exit", "/quit", "exit", "quit"].includes(command)) {
        goodbye();
        break;
      }

      if (command === "/help") {
        line(helpText());
        continue;
      }

      if (command === "/model") {
        clack.note(
          [
            `${ui.dim("provider")}      ${runtimeConfig.provider}`,
            `${ui.dim("model")}         ${runtimeConfig.model}`,
          ].join("\n"),
          `${icons.ai} Model Aktif`,
        );
        continue;
      }

      if (command === "/login") {
        await runLoginWizard(question);
        config = await loadConfig();
        runtimeConfig = await withRuntimePrompt(config);
        messages[0] = { role: "system", content: runtimeConfig.systemPrompt };
        if (tuiActive) {
          updateTuiFrame({ provider: runtimeConfig.provider, model: runtimeConfig.model, theme: runtimeConfig.theme });
        } else if (runtimeConfig.theme !== "no-footer") {
          updatePinnedFooter({ model: runtimeConfig.model, theme: runtimeConfig.theme });
        }
        success("Config aktif sudah diperbarui.");
        blank();
        continue;
      }

      if (command === "/models" || command.startsWith("/models ")) {
        const search = prompt.slice("/models".length).trim();

        try {
          const selectedModel = await runModelPicker(question, {
            initialSearch: search,
            defaultFreeOnly: runtimeConfig.provider === "openrouter",
          });

          if (!selectedModel) {
            info("Model tidak diubah.");
            blank();
            continue;
          }

          config = await loadConfig();
          runtimeConfig = await withRuntimePrompt(config);
          messages[0] = { role: "system", content: runtimeConfig.systemPrompt };
          if (tuiActive) {
            updateTuiFrame({ provider: runtimeConfig.provider, model: runtimeConfig.model, theme: runtimeConfig.theme });
          } else if (runtimeConfig.theme !== "no-footer") {
            updatePinnedFooter({ model: runtimeConfig.model, theme: runtimeConfig.theme });
          }
          success("Config aktif sudah diperbarui.");
          blank();
        } catch (errorValue) {
          printError(formatError(errorValue));
          blank();
        }

        continue;
      }

      if (command === "/session") {
        const summary = await getProjectSessionSummary();
        keyValue("path", summary.path);
        keyValue("saved", summary.exists ? "yes" : "no");
        if (summary.exists) {
          keyValue("messages", String(summary.messageCount ?? 0));
          keyValue("model", summary.model ?? "-");
          keyValue("updated", summary.updatedAt ?? "-");
        }
        blank();
        continue;
      }

      if (command === "/resume") {
        const session = await loadProjectSession();
        if (!session || session.messages.length === 0) {
          warn("Session project belum ada.");
          blank();
          continue;
        }

        messages.splice(1, messages.length - 1, ...session.messages);
        // Ensure system prompt stays in sync with current runtime config
        messages[0] = { role: "system", content: runtimeConfig.systemPrompt };
        success(`Session diload: ${session.messages.length} pesan.`);
        blank();
        continue;
      }

      if (command === "/save") {
        const sessionPath = await saveProjectSession(messages.slice(1), runtimeConfig);
        success(`Session disimpan: ${sessionPath}`);
        blank();
        continue;
      }

      if (command === "/new") {
        messages.splice(1);
        await clearProjectSession();
        if (runtimeConfig.theme !== "no-footer") {
          updatePinnedFooter({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextLimit: DEFAULT_CONTEXT_LIMIT } });
        }
        success("Session baru dibuat.");
        blank();
        continue;
      }

      if (command === "/clear") {
        messages.splice(1);
        await clearProjectSession();
        if (runtimeConfig.theme !== "no-footer") {
          updatePinnedFooter({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextLimit: DEFAULT_CONTEXT_LIMIT } });
        }
        success("History percakapan sesi ini sudah dihapus.");
        blank();
        continue;
      }

      const fileCommandResult = await handleFileCommand(prompt, question);
      if (fileCommandResult.handled) {
        if (fileCommandResult.context) {
          messages.push({ role: "user", content: fileCommandResult.context });
          trimStoredMessages(messages);
          await saveProjectSession(messages.slice(1), runtimeConfig);
          info("Konteks command disimpan otomatis untuk respons berikutnya.");
          blank();
        }
        continue;
      }

      messages.push({ role: "user", content: await buildUserPromptContent(prompt) });
      blank();

      try {
        const answer = await runLiveAssistant(getRequestMessages(messages), runtimeConfig);
        const assistantText = await printAssistantAnswer(answer, question, { textAlreadyPrinted: true });
        messages.push({ role: "assistant", content: assistantText });
        trimStoredMessages(messages);
        await saveProjectSession(messages.slice(1), runtimeConfig);
        blank();
      } catch (errorValue) {
        messages.pop();
        printError(formatError(errorValue));
        blank();
      }
    }
  } finally {
    if (tuiActive) {
      stopTuiFrame();
    } else {
      resetPinnedFooter({ clear: true });
    }
    rl.close();
  }
}
