import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { detectLanguage, highlightCode } from "./markdown.js";
import { blank, code, confirmSwitch, icons, info, keyValue, line, muted, safeSlice, section, success, ui, warn } from "./ui.js";

type QuestionFn = (query: string) => Promise<string>;

export type FilePatch = {
  oldText: string;
  newText: string;
};

export type FileAction =
  | { kind: "write"; filePath: string; content: string }
  | { kind: "patch"; filePath: string; replacements: FilePatch[] }
  | { kind: "delete"; filePath: string }
  | { kind: "mkdir"; filePath: string }
  | { kind: "command"; command: string; cwd?: string };

type ResolvedPath = {
  absolutePath: string;
  displayPath: string;
};

const MAX_READ_BYTES = 200 * 1024;
const MAX_LIST_ITEMS = 200;
const PREVIEW_MAX_LINES = 40;
const DIFF_MAX_LINES = 160;
const DIFF_LCS_MAX_CELLS = 120_000;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_OUTPUT_BYTES = 200 * 1024;
const PROJECT_TREE_MAX_ITEMS = 180;
const PROJECT_TREE_MAX_DEPTH = 3;
const PROJECT_CONTEXT_MAX_CHARS = 9000;
const INSPECT_MAX_FILES = 10;
const INSPECT_MAX_FILE_BYTES = 80 * 1024;
const INSPECT_MAX_FILE_CHARS = 2500;
const INSPECT_TOTAL_MAX_CHARS = 18_000;
const FIND_MAX_RESULTS = 80;
const FIND_MAX_SCAN_ITEMS = 2500;
const FIND_MAX_CONTENT_BYTES = 80 * 1024;
const AUTO_CONTEXT_MAX_FILES = 6;
const AUTO_CONTEXT_MAX_FILE_CHARS = 3200;
const AUTO_CONTEXT_TOTAL_MAX_CHARS = 16_000;
const AUTO_CONTEXT_MAX_SCAN_ITEMS = 1800;
const IGNORED_TREE_ENTRIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".rakit",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

export const FILE_ACTION_SYSTEM_PROMPT = `Kemampuan file Rakit:
- Jika user meminta membuat, menyimpan, mengubah, atau menghapus file/projek, kamu boleh mengirim aksi file khusus.
- Rakit akan meminta approval user sebelum aksi file diterapkan; jangan menulis instruksi approval panjang karena UI Rakit sudah menanganinya.
- Path harus relatif terhadap folder kerja saat ini. Jangan pakai path absolut atau ..

Format aksi:
<rakit_mkdir path="nama-folder"/>

<rakit_file path="path/ke/file.ext">
ISI FILE LENGKAP DI SINI
</rakit_file>

<rakit_delete path="path/ke/file.ext"/>

<rakit_patch path="path/ke/file.ext">
<<<<<<< SEARCH
TEKS LAMA YANG PERSIS ADA DI FILE
=======
TEKS BARU PENGGANTI
>>>>>>> REPLACE
</rakit_patch>

<rakit_command cwd=".">
COMMAND DI SINI
</rakit_command>

Aturan:
- Baca konteks project yang diberikan Rakit sebelum menentukan path.
- Output dari /read, /tree, /find, /inspect dan konteks file otomatis dari prompt user masuk ke konteks percakapan. Jangan minta user paste ulang output command itu.
- Jangan mengarang path. Jika file tidak terlihat di tree/konteks, minta user /inspect <path>, /tree <path>, /find, atau /read dulu.
- Untuk edit file yang sudah ada, prioritaskan <rakit_patch> agar hanya bagian perlu yang berubah.
- Jika ada beberapa perubahan pada file yang sama, gabungkan dalam satu <rakit_patch> dengan beberapa blok SEARCH/REPLACE.
- Pakai <rakit_file> untuk file baru atau jika user meminta rewrite penuh.
- SEARCH pada <rakit_patch> harus exact, unik, dan cukup konteks agar tidak salah replace.
- Jika tidak yakin isi file lama, jangan paksa patch; minta user membaca file atau jalankan command inspeksi dengan approval.
- Jangan taruh markdown triple backtick di dalam tag aksi kecuali memang bagian dari isi file.
- Untuk project multi-file, kirim beberapa <rakit_mkdir>, <rakit_file>, atau <rakit_patch>.
- Untuk menjalankan command, pakai <rakit_command>; Rakit akan meminta approval user lebih dulu.
- Jangan jalankan command destruktif kecuali user jelas meminta.
- Beri penjelasan sangat singkat di luar tag aksi. Jangan menampilkan ulang isi tag aksi dalam bentuk teks biasa.`;

export async function buildRuntimeSystemPrompt(systemPrompt: string): Promise<string> {
  const projectContext = await buildProjectContextPrompt();
  return `${systemPrompt.trim()}\n\n${FILE_ACTION_SYSTEM_PROMPT}\n\n${projectContext}`;
}

function normalizeDisplayPath(absolutePath: string): string {
  const relative = path.relative(process.cwd(), absolutePath) || ".";
  return relative.split(path.sep).join("/");
}

function isIgnoredTreeEntry(name: string): boolean {
  return IGNORED_TREE_ENTRIES.has(name) || name.endsWith(".log") || name.endsWith(".tmp");
}

function assertSafeRelativePath(rawPath: string): ResolvedPath {
  const trimmedPath = rawPath.trim();

  if (!trimmedPath) {
    throw new Error("Path tidak boleh kosong.");
  }

  if (trimmedPath.includes("\0")) {
    throw new Error(`Path tidak valid: ${rawPath}`);
  }

  if (path.isAbsolute(trimmedPath)) {
    throw new Error(`Path harus relatif terhadap project: ${rawPath}`);
  }

  const normalizedInput = path.normalize(trimmedPath);

  if (normalizedInput === ".." || normalizedInput.startsWith(`..${path.sep}`)) {
    throw new Error(`Path tidak boleh keluar dari folder project: ${rawPath}`);
  }

  const root = path.resolve(process.cwd());
  const absolutePath = path.resolve(root, normalizedInput);
  const rootForCompare = normalizePathForCompare(root);
  const pathForCompare = normalizePathForCompare(absolutePath);
  const rootWithSeparator = rootForCompare.endsWith(path.sep) ? rootForCompare : `${rootForCompare}${path.sep}`;

  if (pathForCompare !== rootForCompare && !pathForCompare.startsWith(rootWithSeparator)) {
    throw new Error(`Path tidak boleh keluar dari folder project: ${rawPath}`);
  }

  return {
    absolutePath,
    displayPath: normalizeDisplayPath(absolutePath),
  };
}

function normalizePathForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootForCompare = normalizePathForCompare(root);
  const candidateForCompare = normalizePathForCompare(candidate);
  const rootWithSeparator = rootForCompare.endsWith(path.sep) ? rootForCompare : `${rootForCompare}${path.sep}`;

  return candidateForCompare === rootForCompare || candidateForCompare.startsWith(rootWithSeparator);
}

async function getRealProjectRoot(): Promise<string> {
  try {
    return await fs.realpath(process.cwd());
  } catch {
    return path.resolve(process.cwd());
  }
}

async function findNearestExistingPath(absolutePath: string): Promise<string> {
  let currentPath = absolutePath;

  while (true) {
    try {
      await fs.lstat(currentPath);
      return currentPath;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code !== "ENOENT") {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw new Error("Folder project tidak ditemukan.");
      }

      currentPath = parentPath;
    }
  }
}

async function assertRealPathInsideProject(resolved: ResolvedPath, rawPath: string): Promise<void> {
  const root = await getRealProjectRoot();
  const nearestExistingPath = await findNearestExistingPath(resolved.absolutePath);
  const realPath = await fs.realpath(nearestExistingPath);

  if (!isPathInsideRoot(root, realPath)) {
    throw new Error(`Path tidak boleh melewati symlink ke luar project: ${rawPath}`);
  }
}

async function resolveSafePath(rawPath: string): Promise<ResolvedPath> {
  const resolved = assertSafeRelativePath(rawPath);
  await assertRealPathInsideProject(resolved, rawPath);
  return resolved;
}

async function validateFileActionPaths(actions: FileAction[]): Promise<void> {
  for (const action of actions) {
    if (action.kind === "command") {
      if (action.cwd) await resolveSafePath(action.cwd);
      continue;
    }

    await resolveSafePath(action.filePath);
  }
}

function normalizeGeneratedContent(content: string): string {
  // Strip exactly one leading newline (artifact from XML tag opening),
  // and exactly one trailing newline (artifact from XML tag closing).
  // Preserving any additional newlines that are part of the actual file content.
  let result = content;
  if (result.startsWith("\n")) {
    result = result.slice(1);
  }
  if (result.endsWith("\n")) {
    result = result.slice(0, -1);
  }
  return result;
}

function getLineCount(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRegex = /(\w+)=(['"])(.*?)\2/g;
  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(rawAttributes)) !== null) {
    attributes[match[1]] = match[3];
  }

  return attributes;
}

export function isApprovalBoilerplateLine(lineText: string): boolean {
  const normalized = lineText.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(approve|approval)\b/.test(normalized) && /\b(silakan|harap|dulu|konfirmasi|terapkan|apply)\b/.test(normalized)) return true;
  if (/silakan.*\b(konfirmasi|terapkan)\b/.test(normalized)) return true;
  if (/rakit.*\b(meminta|minta)\b.*\bkonfirmasi\b/.test(normalized)) return true;
  if (/nanti perubahan.*diterapkan/.test(normalized)) return true;
  return false;
}

function removeFileActionBlocks(text: string): string {
  return text
    .replace(/<rakit_file\b[\s\S]*?<\/rakit_file>/gi, "")
    .replace(/<rakit_patch\b[\s\S]*?<\/rakit_patch>/gi, "")
    .replace(/<rakit_command\b[\s\S]*?<\/rakit_command>/gi, "")
    .replace(/<rakit_(?:delete|mkdir)\b[\s\S]*?\/>/gi, "")
    .split(/\r?\n/)
    .filter((lineText) => !isApprovalBoilerplateLine(lineText))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parsePatchBlocks(content: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const patchRegex = /<<<<<<< SEARCH\s*\r?\n([\s\S]*?)\r?\n=======\s*\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let match: RegExpExecArray | null;

  while ((match = patchRegex.exec(content)) !== null) {
    patches.push({ oldText: match[1], newText: match[2] });
  }

  return patches;
}

export function extractFileActions(responseText: string): { displayText: string; actions: FileAction[] } {
  const actions: FileAction[] = [];
  const actionRegex = /<rakit_file\b([^>]*)>([\s\S]*?)<\/rakit_file>|<rakit_patch\b([^>]*)>([\s\S]*?)<\/rakit_patch>|<rakit_command\b([^>]*)>([\s\S]*?)<\/rakit_command>|<rakit_(delete|mkdir)\b([^>]*)\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = actionRegex.exec(responseText)) !== null) {
    if (match[1] !== undefined) {
      const attributes = parseAttributes(match[1]);
      const filePath = attributes.path;

      if (!filePath) continue;

      actions.push({
        kind: "write",
        filePath,
        content: normalizeGeneratedContent(match[2]),
      });
      continue;
    }

    if (match[3] !== undefined) {
      const attributes = parseAttributes(match[3]);
      const filePath = attributes.path;
      const replacements = parsePatchBlocks(normalizeGeneratedContent(match[4]));

      if (!filePath || replacements.length === 0) continue;

      actions.push({ kind: "patch", filePath, replacements });
      continue;
    }

    if (match[5] !== undefined) {
      const attributes = parseAttributes(match[5]);
      const command = normalizeGeneratedContent(match[6]).trim();

      if (!command) continue;

      actions.push({ kind: "command", command, cwd: attributes.cwd });
      continue;
    }

    const kind = match[7].toLowerCase() as "delete" | "mkdir";
    const attributes = parseAttributes(match[8]);
    const filePath = attributes.path;

    if (!filePath) continue;

    actions.push({ kind, filePath });
  }

  return {
    displayText: removeFileActionBlocks(responseText),
    actions,
  };
}

export function formatFileAction(action: FileAction, index?: number): string {
  const prefix = index === undefined ? "" : `${ui.dim(`${index + 1}.`)} `;

  switch (action.kind) {
    case "write":
      return `${prefix}${ui.cyan(icons.file)} tulis/edit ${code(action.filePath)} ${muted(`(${getLineCount(action.content)} baris, ${formatBytes(Buffer.byteLength(action.content, "utf8"))})`)}`;
    case "patch":
      return `${prefix}${ui.cyan(icons.file)} patch ${code(action.filePath)} ${muted(`(${action.replacements.length} perubahan)`)}`;
    case "delete":
      return `${prefix}${ui.red(icons.error)} hapus ${code(action.filePath)}`;
    case "mkdir":
      return `${prefix}${ui.blue(icons.folder)} buat folder ${code(action.filePath)}`;
    case "command":
      return `${prefix}${ui.magenta(icons.arrow)} jalankan ${code(action.command)}${action.cwd ? muted(` (cwd ${action.cwd})`) : ""}`;
  }
}

type DiffLine = {
  kind: "same" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
};

type DiffSource = {
  content?: string;
  note?: string;
};

function splitContentLines(content: string): string[] {
  return content ? content.split(/\r?\n/) : [];
}

function buildSimpleDiff(oldContent: string, newContent: string): DiffLine[] {
  return [
    ...splitContentLines(oldContent).map((text, index) => ({
      kind: "remove" as const,
      text,
      oldLine: index + 1,
    })),
    ...splitContentLines(newContent).map((text, index) => ({
      kind: "add" as const,
      text,
      newLine: index + 1,
    })),
  ];
}

function buildLineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);
  const cellCount = (oldLines.length + 1) * (newLines.length + 1);

  if (cellCount > DIFF_LCS_MAX_CELLS) {
    return buildSimpleDiff(oldContent, newContent);
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      dp[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? dp[oldIndex + 1][newIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push({
        kind: "same",
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex++;
      newIndex++;
      continue;
    }

    if (dp[oldIndex + 1][newIndex] >= dp[oldIndex][newIndex + 1]) {
      diff.push({ kind: "remove", text: oldLines[oldIndex], oldLine: oldIndex + 1 });
      oldIndex++;
    } else {
      diff.push({ kind: "add", text: newLines[newIndex], newLine: newIndex + 1 });
      newIndex++;
    }
  }

  while (oldIndex < oldLines.length) {
    diff.push({ kind: "remove", text: oldLines[oldIndex], oldLine: oldIndex + 1 });
    oldIndex++;
  }

  while (newIndex < newLines.length) {
    diff.push({ kind: "add", text: newLines[newIndex], newLine: newIndex + 1 });
    newIndex++;
  }

  return diff;
}

function formatDiffText(diffLine: DiffLine, language?: string): string {
  const text = diffLine.text || " ";

  if (language) {
    return highlightCode(text, language);
  }

  if (diffLine.kind === "add") return ui.green(text);
  if (diffLine.kind === "remove") return ui.red(text);
  return ui.dim(text);
}

function buildDiffHunks(diff: DiffLine[], contextLines = 3): Array<{ start: number; end: number }> {
  const changedIndexes = diff
    .map((diffLine, index) => diffLine.kind === "same" ? -1 : index)
    .filter((index) => index !== -1);

  if (changedIndexes.length === 0) return [];

  const hunks: Array<{ start: number; end: number }> = [];

  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - contextLines);
    const end = Math.min(diff.length - 1, changedIndex + contextLines);
    const lastHunk = hunks[hunks.length - 1];

    if (lastHunk && start <= lastHunk.end + 1) {
      lastHunk.end = Math.max(lastHunk.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  return hunks;
}

function getDisplayLineNumber(diffLine: DiffLine): string {
  const lineNumber = diffLine.kind === "add"
    ? diffLine.newLine
    : diffLine.oldLine ?? diffLine.newLine;

  return lineNumber === undefined ? "    " : String(lineNumber).padStart(4);
}

function formatDiffSign(kind: DiffLine["kind"]): string {
  if (kind === "add") return ui.green("+");
  if (kind === "remove") return ui.red("-");
  return " ";
}

function printDiffLine(diffLine: DiffLine, language?: string): void {
  const sign = formatDiffSign(diffLine.kind);
  const lineNumber = getDisplayLineNumber(diffLine);
  const text = formatDiffText(diffLine, language);
  const lineNumberText = diffLine.kind === "add"
    ? ui.green(lineNumber)
    : diffLine.kind === "remove"
      ? ui.red(lineNumber)
      : ui.dim(lineNumber);

  line(`${sign}${lineNumberText}       ${text}`);
}

function getDiffSummary(diff: DiffLine[]): string {
  const added = diff.filter((diffLine) => diffLine.kind === "add").length;
  const removed = diff.filter((diffLine) => diffLine.kind === "remove").length;
  return `${ui.green(`+${added}`)} ${ui.red(`-${removed}`)}`;
}

function getHunkHeader(diff: DiffLine[], hunk: { start: number; end: number }): string {
  const hunkLines = diff.slice(hunk.start, hunk.end + 1);
  const firstOldLine = hunkLines.find((diffLine) => diffLine.oldLine !== undefined)?.oldLine ?? 0;
  const firstNewLine = hunkLines.find((diffLine) => diffLine.newLine !== undefined)?.newLine ?? 0;
  const oldCount = hunkLines.filter((diffLine) => diffLine.kind !== "add").length;
  const newCount = hunkLines.filter((diffLine) => diffLine.kind !== "remove").length;

  return ui.dim(`@@ -${firstOldLine},${oldCount} +${firstNewLine},${newCount} @@`);
}

function printDiff(diff: DiffLine[], filePath?: string): void {
  const language = filePath ? detectLanguage(filePath) : undefined;
  const hunks = buildDiffHunks(diff);

  if (hunks.length === 0) {
    info("Tidak ada perubahan.");
    return;
  }

  line(`${ui.dim("ringkasan")} ${getDiffSummary(diff)} ${muted(`${hunks.length} hunk`)}`);

  let printedLines = 0;
  let lastEnd = -1;

  for (const hunk of hunks) {
    if (printedLines >= DIFF_MAX_LINES) break;

    if (hunk.start > lastEnd + 1) {
      line(ui.dim("      ..."));
    }

    line(getHunkHeader(diff, hunk));

    for (let index = hunk.start; index <= hunk.end; index++) {
      if (printedLines >= DIFF_MAX_LINES) break;
      printDiffLine(diff[index], language);
      printedLines++;
    }

    lastEnd = hunk.end;
  }

  if (lastEnd < diff.length - 1) {
    line(ui.dim("      ..."));
  }

  if (printedLines >= DIFF_MAX_LINES) {
    line(ui.dim(`      ... diff dipotong (${diff.length - printedLines} baris lain) ...`));
  }
}

async function readDiffSource(resolved: ResolvedPath): Promise<DiffSource> {
  try {
    const stat = await fs.stat(resolved.absolutePath);

    if (stat.isDirectory()) {
      return { note: "path saat ini adalah folder" };
    }

    if (!stat.isFile()) {
      return { note: "path bukan file biasa" };
    }

    if (stat.size > MAX_READ_BYTES) {
      return { note: `file terlalu besar untuk diff (${formatBytes(stat.size)})` };
    }

    return { content: await fs.readFile(resolved.absolutePath, "utf8") };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return { content: "" };
    }

    return { note: nodeError.message || "gagal membaca file lama" };
  }
}

async function printWriteDiff(action: Extract<FileAction, { kind: "write" }>): Promise<void> {
  const resolved = await resolveSafePath(action.filePath);
  const oldSource = await readDiffSource(resolved);

  if (oldSource.note) {
    warn(oldSource.note);
    const previewLines = splitContentLines(action.content).slice(0, PREVIEW_MAX_LINES);
    line(`${ui.green("create")} ${code(action.filePath)}`);
    printDiff(previewLines.map((text, index) => ({ kind: "add", text, newLine: index + 1 })), action.filePath);
    return;
  }

  const oldContent = oldSource.content ?? "";

  if (oldContent === action.content) {
    info(`${code(action.filePath)} tidak berubah.`);
    return;
  }

  line(`${oldContent ? ui.cyan("edit") : ui.green("create")} ${code(action.filePath)}`);
  printDiff(buildLineDiff(oldContent, action.content), action.filePath);
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;

  let count = 0;
  let index = content.indexOf(search);

  while (index !== -1) {
    count++;
    index = content.indexOf(search, index + search.length);
  }

  return count;
}

function applyPatchToContent(filePath: string, content: string, replacements: FilePatch[]): string {
  let result = content;

  for (const [index, replacement] of replacements.entries()) {
    if (!replacement.oldText) {
      throw new Error(`Patch ${index + 1} untuk ${filePath} tidak punya SEARCH.`);
    }

    const occurrenceCount = countOccurrences(result, replacement.oldText);

    if (occurrenceCount === 0) {
      if (replacement.newText && countOccurrences(result, replacement.newText) > 0) {
        continue;
      }

      throw new Error(`Patch ${index + 1} tidak cocok di ${filePath}. SEARCH tidak ditemukan.`);
    }

    if (occurrenceCount > 1) {
      throw new Error(`Patch ${index + 1} ambigu di ${filePath}. SEARCH ditemukan ${occurrenceCount} kali.`);
    }

    result = result.replace(replacement.oldText, replacement.newText);
  }

  return result;
}

async function printPatchDiff(action: Extract<FileAction, { kind: "patch" }>): Promise<void> {
  const resolved = await resolveSafePath(action.filePath);
  const oldSource = await readDiffSource(resolved);

  if (oldSource.note) {
    warn(`${code(action.filePath)}: ${oldSource.note}`);
    return;
  }

  const oldContent = oldSource.content ?? "";

  try {
    const newContent = applyPatchToContent(action.filePath, oldContent, action.replacements);
    line(`${ui.cyan("edit")} ${code(action.filePath)}`);
    printDiff(buildLineDiff(oldContent, newContent), action.filePath);
  } catch (errorValue) {
    warn(formatPatchError(errorValue));
  }
}

function formatPatchError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

async function printDeleteDiff(action: Extract<FileAction, { kind: "delete" }>): Promise<void> {
  const resolved = await resolveSafePath(action.filePath);
  const oldSource = await readDiffSource(resolved);

  if (oldSource.note) {
    warn(`${code(action.filePath)}: ${oldSource.note}`);
    return;
  }

  const oldContent = oldSource.content ?? "";

  if (!oldContent) {
    info(`${code(action.filePath)} tidak ditemukan atau kosong.`);
    return;
  }

  line(`${ui.red("delete")} ${code(action.filePath)}`);
  printDiff(buildLineDiff(oldContent, ""), action.filePath);
}

async function printFileActionDetails(actions: FileAction[]): Promise<void> {
  for (const [index, action] of actions.entries()) {
    if (index > 0) blank();

    if (action.kind === "write") {
      await printWriteDiff(action);
    } else if (action.kind === "patch") {
      await printPatchDiff(action);
    } else if (action.kind === "delete") {
      await printDeleteDiff(action);
    } else if (action.kind === "command") {
      line(`${ui.magenta("run")} ${code(action.command)}`);
      keyValue("cwd", action.cwd ?? ".");
    } else {
      line(`${ui.blue("mkdir")} ${code(action.filePath)}`);
      info("Folder akan dibuat jika belum ada.");
    }
  }
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function appendLimitedOutput(current: string, chunk: string): string {
  const next = current + chunk;
  const byteLength = Buffer.byteLength(next, "utf8");

  if (byteLength <= COMMAND_MAX_OUTPUT_BYTES) {
    return next;
  }

  // Slice by byte length, not character count, to correctly enforce the limit
  const truncated = Buffer.from(next, "utf8").subarray(0, COMMAND_MAX_OUTPUT_BYTES).toString("utf8");
  return `${truncated}\n... output dipotong ...`;
}

export async function executeShellCommand(rawCommand: string, rawCwd = "."): Promise<string> {
  const command = rawCommand.trim();

  if (!command) {
    throw new Error("Command tidak boleh kosong.");
  }

  if (command.includes("\0")) {
    throw new Error("Command tidak valid.");
  }

  const resolvedCwd = await resolveSafePath(rawCwd || ".");
  let output = "";

  return new Promise((resolve, reject) => {
    let settled = false;

    const child = spawn(command, {
      cwd: resolvedCwd.absolutePath,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Proses mungkin sudah selesai.
      }
      reject(new Error(`Command timeout setelah ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s: ${command}`));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = appendLimitedOutput(output, text);
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = appendLimitedOutput(output, text);
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", (codeValue) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (codeValue === 0) {
        resolve(`command selesai: ${command}`);
        return;
      }

      reject(new Error(`Command gagal (${codeValue ?? "unknown"}): ${command}${output ? `\n${output}` : ""}`));
    });
  });
}

export async function applyFileAction(action: FileAction): Promise<string> {
  const resolved = action.kind === "command" ? undefined : await resolveSafePath(action.filePath);

  switch (action.kind) {
    case "mkdir": {
      if (!resolved) throw new Error("Path tidak valid.");
      await fs.mkdir(resolved.absolutePath, { recursive: true });
      return `folder dibuat: ${resolved.displayPath}`;
    }
    case "write": {
      if (!resolved) throw new Error("Path tidak valid.");
      const existed = await pathExists(resolved.absolutePath);
      await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      await fs.writeFile(resolved.absolutePath, action.content, "utf8");
      return `${existed ? "file diubah" : "file dibuat"}: ${resolved.displayPath}`;
    }
    case "patch": {
      if (!resolved) throw new Error("Path tidak valid.");
      const oldContent = await fs.readFile(resolved.absolutePath, "utf8");
      const newContent = applyPatchToContent(action.filePath, oldContent, action.replacements);
      await fs.writeFile(resolved.absolutePath, newContent, "utf8");
      return `file dipatch: ${resolved.displayPath}`;
    }
    case "delete": {
      if (!resolved) throw new Error("Path tidak valid.");
      await fs.rm(resolved.absolutePath, { recursive: true, force: false });
      return `dihapus: ${resolved.displayPath}`;
    }
    case "command": {
      return executeShellCommand(action.command, action.cwd);
    }
  }
}

export async function applyFileActions(actions: FileAction[]): Promise<string[]> {
  const pendingActions = normalizeFileActions(actions);
  await validateFileActionPaths(pendingActions);
  await validatePatchActionsCanApply(pendingActions);

  const results: string[] = [];

  for (const action of pendingActions) {
    results.push(await applyFileAction(action));
  }

  return results;
}

function parseApprovalAnswer(answer: string, defaultValue: boolean): boolean | "detail" | undefined {
  const value = answer.trim().toLowerCase();

  if (!value) return defaultValue;
  if (["y", "yes", "ya", "iya", "1", "ok", "oke", "gas", "lanjut", "apply", "terapkan"].includes(value)) return true;
  if (["n", "no", "tidak", "t", "0", "batal", "cancel"].includes(value)) return false;
  if (["d", "detail", "diff", "lihat", "preview"].includes(value)) return "detail";

  return undefined;
}

function normalizeFileActions(actions: FileAction[]): FileAction[] {
  const normalized: FileAction[] = [];

  for (const action of actions) {
    const lastAction = normalized[normalized.length - 1];

    if (action.kind === "patch" && lastAction?.kind === "patch" && lastAction.filePath === action.filePath) {
      lastAction.replacements.push(...action.replacements);
      continue;
    }

    if (action.kind === "patch") {
      normalized.push({ ...action, replacements: [...action.replacements] });
      continue;
    }

    normalized.push(action);
  }

  return normalized;
}

function isSensitiveAction(action: FileAction): boolean {
  return action.kind === "command" || action.kind === "delete";
}

function formatCompactAction(action: FileAction): string {
  switch (action.kind) {
    case "write":
      return `${ui.green("write")} ${code(action.filePath)} ${muted(`${getLineCount(action.content)} baris`)}`;
    case "patch":
      return `${ui.cyan("edit")} ${code(action.filePath)} ${muted(`${action.replacements.length} perubahan`)}`;
    case "delete":
      return `${ui.red("delete")} ${code(action.filePath)}`;
    case "mkdir":
      return `${ui.blue("mkdir")} ${code(action.filePath)}`;
    case "command":
      return `${ui.magenta("run")} ${code(action.command)}${action.cwd ? muted(` cwd ${action.cwd}`) : ""}`;
  }
}

async function validatePatchActionsCanApply(actions: FileAction[]): Promise<void> {
  for (const action of actions) {
    if (action.kind !== "patch") continue;

    const resolved = await resolveSafePath(action.filePath);
    const oldSource = await readDiffSource(resolved);

    if (oldSource.note) {
      throw new Error(`${action.filePath}: ${oldSource.note}`);
    }

    applyPatchToContent(action.filePath, oldSource.content ?? "", action.replacements);
  }
}

function printApplySummary(results: string[]): void {
  if (results.length === 1) {
    success(results[0]);
    return;
  }

  success(`${results.length} aksi selesai`);
  for (const result of results) {
    line(`  ${icons.bullet} ${result}`);
  }
}

export async function confirmAndApplyFileActions(actions: FileAction[], question: QuestionFn): Promise<boolean> {
  if (actions.length === 0) return false;

  const pendingActions = normalizeFileActions(actions);
  await validateFileActionPaths(pendingActions);

  try {
    await validatePatchActionsCanApply(pendingActions);
  } catch (errorValue) {
    blank();
    warn(formatPatchError(errorValue));
    info("Perubahan tidak diterapkan agar file tidak setengah berubah. Minta Rakit coba patch ulang setelah konteks file terbaru tersedia.");
    blank();
    return false;
  }

  const sensitive = pendingActions.some(isSensitiveAction);
  const defaultApply = !sensitive;

  blank();
  section(sensitive ? "Aksi perlu approval" : "Perubahan siap");
  for (const action of pendingActions.slice(0, 6)) {
    line(`  ${icons.bullet} ${formatCompactAction(action)}`);
  }
  if (pendingActions.length > 6) {
    line(muted(`  ... ${pendingActions.length - 6} aksi lain`));
  }

  while (true) {
    const switchChoice = await confirmSwitch({
      message: "Terapkan perubahan?",
      defaultChoice: defaultApply ? "accept" : "reject",
      detailLabel: "Detail/Diff",
    });
    const parsed = switchChoice === "detail"
      ? "detail"
      : switchChoice === "accept"
        ? true
        : switchChoice === "reject"
          ? false
          : parseApprovalAnswer(
            await question(`${ui.yellow("?")} Terapkan? ${muted(defaultApply ? "[Enter/y apply · d diff · n batal]" : "[y apply · d diff · Enter/n batal]")}: `),
            defaultApply,
          );

    if (parsed === "detail") {
      blank();
      section("Diff");
      await printFileActionDetails(pendingActions);
      blank();
      continue;
    }

    if (parsed === true) {
      const results: string[] = [];

      for (const action of pendingActions) {
        results.push(await applyFileAction(action));
      }

      printApplySummary(results);
      blank();
      return true;
    }

    if (parsed === false) {
      warn("Dibatalkan.");
      blank();
      return false;
    }

    info("Pilih Accept, Reject, atau Detail/Diff.");
  }
}

type TreeLineOptions = {
  maxDepth: number;
  maxItems: number;
  color: boolean;
};

type TreeCounter = {
  count: number;
  truncated: boolean;
};

function formatTreeName(entry: { name: string; isDirectory(): boolean }, color: boolean): string {
  const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
  return color && entry.isDirectory() ? ui.blue(ui.bold(name)) : name;
}

async function collectTreeLines(
  absolutePath: string,
  prefix: string,
  depth: number,
  options: TreeLineOptions,
  counter: TreeCounter,
): Promise<string[]> {
  if (depth > options.maxDepth || counter.count >= options.maxItems) return [];

  let entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries = entries
    .filter((entry) => !isIgnoredTreeEntry(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const lines: string[] = [];

  for (const [index, entry] of entries.entries()) {
    if (counter.count >= options.maxItems) {
      counter.truncated = true;
      break;
    }

    const isLast = index === entries.length - 1 || counter.count + 1 >= options.maxItems;
    const connector = isLast ? icons.corner : icons.tee;
    const nextPrefix = `${prefix}${isLast ? "   " : `${icons.bar}  `}`;
    const displayName = formatTreeName(entry, options.color);

    lines.push(`${prefix}${connector}${icons.dash}${icons.dash} ${displayName}`);
    counter.count++;

    if (entry.isDirectory() && depth < options.maxDepth) {
      lines.push(...await collectTreeLines(path.join(absolutePath, entry.name), nextPrefix, depth + 1, options, counter));
    }
  }

  return lines;
}

async function buildProjectTreeText(rawPath = ".", options: Partial<TreeLineOptions> = {}): Promise<{ label: string; lines: string[]; truncated: boolean; count: number }> {
  const resolved = await resolveSafePath(rawPath);
  const counter: TreeCounter = { count: 0, truncated: false };
  const treeOptions: TreeLineOptions = {
    maxDepth: options.maxDepth ?? PROJECT_TREE_MAX_DEPTH,
    maxItems: options.maxItems ?? PROJECT_TREE_MAX_ITEMS,
    color: options.color ?? false,
  };
  const lines = await collectTreeLines(resolved.absolutePath, "", 1, treeOptions, counter);

  return {
    label: resolved.displayPath,
    lines,
    truncated: counter.truncated,
    count: counter.count,
  };
}

async function readPackageSummary(): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const lines: string[] = [];

    if (typeof parsed.name === "string") {
      lines.push(`name: ${parsed.name}`);
    }

    const scripts = parsed.scripts ? Object.keys(parsed.scripts).slice(0, 12) : [];
    if (scripts.length > 0) {
      lines.push(`scripts: ${scripts.join(", ")}`);
    }

    const deps = parsed.dependencies ? Object.keys(parsed.dependencies).slice(0, 16) : [];
    if (deps.length > 0) {
      lines.push(`deps: ${deps.join(", ")}`);
    }

    const devDeps = parsed.devDependencies ? Object.keys(parsed.devDependencies).slice(0, 16) : [];
    if (devDeps.length > 0) {
      lines.push(`devDeps: ${devDeps.join(", ")}`);
    }

    return lines.length > 0 ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

export async function buildProjectContextPrompt(): Promise<string> {
  try {
    const tree = await buildProjectTreeText(".", { color: false, maxDepth: PROJECT_TREE_MAX_DEPTH, maxItems: PROJECT_TREE_MAX_ITEMS });
    const packageSummary = await readPackageSummary();
    const parts = [
      "Konteks project otomatis:",
      `cwd: ${process.cwd()}`,
      packageSummary ? `package.json:\n${packageSummary}` : undefined,
      `tree ${tree.label} (${tree.count} item${tree.truncated ? ", dipotong" : ""}):`,
      tree.lines.length > 0 ? tree.lines.join("\n") : "(kosong)",
      "Instruksi inspeksi: gunakan path dari tree ini. Jika perlu detail, minta user /inspect <path>, /read <path>, /tree <path>, /find <keyword>, atau kirim <rakit_command> dengan approval jika perlu. Jangan minta user paste ulang output command; Rakit memasukkannya otomatis ke konteks.",
    ].filter(Boolean).join("\n");

    return parts.length > PROJECT_CONTEXT_MAX_CHARS
      ? `${safeSlice(parts, PROJECT_CONTEXT_MAX_CHARS)}\n... konteks project dipotong ...`
      : parts;
  } catch (errorValue) {
    return `Konteks project otomatis gagal dibuat: ${errorValue instanceof Error ? errorValue.message : String(errorValue)}`;
  }
}

// ── Tree-style directory listing ───────────────────────────────────────
export async function listProjectTree(rawPath = "."): Promise<string> {
  const tree = await buildProjectTreeText(rawPath, { color: true, maxDepth: PROJECT_TREE_MAX_DEPTH, maxItems: PROJECT_TREE_MAX_ITEMS });
  const header = `${ui.bold("Tree")} ${code(tree.label)} ${ui.dim(`(${tree.count} item${tree.truncated ? ", dipotong" : ""})`)}`;
  const body = tree.lines.length > 0 ? tree.lines.map((treeLine) => `  ${treeLine}`).join("\n") : muted("  (kosong)");
  return `${header}\n${body}`;
}

type ProjectSearchMatch = {
  kind: "file" | "directory";
  relativePath: string;
  absolutePath: string;
  score: number;
  contentLine?: string;
};

const SHORT_SEARCH_TERMS = new Set(["js", "ts", "go", "py", "rs", "ui", "db"]);
const AUTO_CONTEXT_STOPWORDS = new Set([
  "aku",
  "akan",
  "aja",
  "atau",
  "buat",
  "bikin",
  "bisa",
  "dan",
  "dari",
  "dengan",
  "edit",
  "file",
  "folder",
  "ini",
  "itu",
  "jadi",
  "jangan",
  "ke",
  "lagi",
  "menjadi",
  "mulai",
  "nama",
  "namanya",
  "nya",
  "page",
  "projek",
  "project",
  "saya",
  "the",
  "to",
  "tolong",
  "ubah",
  "untuk",
  "update",
  "yang",
]);

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._/\\-]+/g, " ")
    .replace(/[._/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulSearchTerm(term: string): boolean {
  return term.length >= 3 || SHORT_SEARCH_TERMS.has(term);
}

function getSearchTerms(keyword: string, options: { forAutoContext?: boolean } = {}): string[] {
  const terms = normalizeSearchText(keyword)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .filter(isUsefulSearchTerm)
    .filter((term) => !options.forAutoContext || !AUTO_CONTEXT_STOPWORDS.has(term));

  return [...new Set(terms)].slice(0, 12);
}

function isInspectableFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("package-lock.json") || lower.endsWith("pnpm-lock.yaml") || lower.endsWith("yarn.lock")) return false;
  return /(?:package\.json|readme\.md|\.(?:html|css|js|jsx|ts|tsx|json|md|py|go|rs|java|php|vue|svelte))$/i.test(lower);
}

function scoreSearchText(text: string, terms: string[]): number {
  const normalized = normalizeSearchText(text);
  let score = 0;

  for (const term of terms) {
    if (normalized === term) score += 25;
    else if (normalized.split(" ").includes(term)) score += 14;
    else if (normalized.includes(term)) score += 8;
  }

  return score;
}

function findContentMatchLine(content: string, terms: string[]): { line: string; score: number } | undefined {
  const lines = content.split(/\r?\n/).slice(0, 800);
  let best: { line: string; score: number } | undefined;

  for (const sourceLine of lines) {
    const score = scoreSearchText(sourceLine, terms);
    if (score === 0) continue;

    const line = sourceLine.trim();
    if (!line) continue;

    if (!best || score > best.score) {
      best = { line: line.length > 140 ? `${line.slice(0, 140)}…` : line, score };
    }
  }

  return best;
}

async function collectProjectSearchMatches(terms: string[], options: { maxResults?: number; maxScanItems?: number; includeContent?: boolean } = {}): Promise<ProjectSearchMatch[]> {
  const root = path.resolve(process.cwd());
  const maxResults = options.maxResults ?? FIND_MAX_RESULTS;
  const maxScanItems = options.maxScanItems ?? FIND_MAX_SCAN_ITEMS;
  const results: ProjectSearchMatch[] = [];
  let scannedItems = 0;

  async function walk(absolutePath: string, depth: number): Promise<void> {
    if (depth > 8 || scannedItems >= maxScanItems) return;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    entries = entries
      .filter((entry) => !entry.isSymbolicLink() && !isIgnoredTreeEntry(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (scannedItems >= maxScanItems) break;
      scannedItems++;

      const childPath = path.join(absolutePath, entry.name);
      const relativePath = path.relative(root, childPath).split(path.sep).join("/");
      const pathScore = scoreSearchText(relativePath, terms) + scoreSearchText(entry.name, terms);

      if (entry.isDirectory()) {
        if (pathScore > 0) {
          results.push({ kind: "directory", relativePath, absolutePath: childPath, score: pathScore + 4 });
        }
        await walk(childPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      let score = pathScore;
      let contentLine: string | undefined;

      if (options.includeContent && isInspectableFile(relativePath)) {
        try {
          const stat = await fs.stat(childPath);
          if (stat.size <= FIND_MAX_CONTENT_BYTES) {
            const content = await fs.readFile(childPath, "utf8");
            const contentMatch = findContentMatchLine(content, terms);
            if (contentMatch) {
              score += contentMatch.score;
              contentLine = contentMatch.line;
            }
          }
        } catch {
          // Ignore unreadable files during search.
        }
      }

      if (score > 0) {
        results.push({ kind: "file", relativePath, absolutePath: childPath, score, contentLine });
      }
    }
  }

  await walk(root, 0);

  return results
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, maxResults);
}

export async function findProjectFiles(keyword: string): Promise<string> {
  const terms = getSearchTerms(keyword);

  if (terms.length === 0) {
    throw new Error("Keyword tidak boleh kosong.");
  }

  const matches = await collectProjectSearchMatches(terms, { includeContent: true, maxResults: FIND_MAX_RESULTS });

  if (matches.length === 0) {
    return `Tidak ada path cocok untuk: ${keyword}`;
  }

  const lines = matches.map((match) => {
    const pathText = match.kind === "directory" ? `${match.relativePath}/` : match.relativePath;
    const contentHint = match.contentLine ? muted(` — ${match.contentLine}`) : "";
    return `  ${icons.bullet} ${pathText}${contentHint}`;
  });

  return `${ui.bold("Hasil find")} ${code(keyword)} ${ui.dim(`(${matches.length} hasil)`)}\n${lines.join("\n")}`;
}

function shouldBuildAutoPromptContext(prompt: string, terms: string[]): boolean {
  if (terms.length === 0 || prompt.trim().startsWith("/")) return false;
  return /\b(edit|ubah|update|perbaiki|tambahkan|hapus|buat|bikin|file|folder|project|projek|page|halaman|login|dashboard|css|html|javascript|typescript|script|style|component|komponen)\b/i.test(prompt);
}

async function readAutoContextFile(match: ProjectSearchMatch): Promise<string | undefined> {
  if (match.kind !== "file" || !isInspectableFile(match.relativePath)) return undefined;

  try {
    const stat = await fs.stat(match.absolutePath);
    if (!stat.isFile() || stat.size > FIND_MAX_CONTENT_BYTES) return undefined;

    const content = await fs.readFile(match.absolutePath, "utf8");
    const clipped = content.length > AUTO_CONTEXT_MAX_FILE_CHARS
      ? `${content.slice(0, AUTO_CONTEXT_MAX_FILE_CHARS)}\n... file dipotong ...`
      : content;

    return `--- ${match.relativePath} ---\n${clipped}`;
  } catch {
    return undefined;
  }
}

export async function buildPromptFileContext(prompt: string): Promise<string | undefined> {
  const terms = getSearchTerms(prompt, { forAutoContext: true });
  if (!shouldBuildAutoPromptContext(prompt, terms)) return undefined;

  const matches = await collectProjectSearchMatches(terms, {
    includeContent: true,
    maxResults: AUTO_CONTEXT_MAX_FILES * 3,
    maxScanItems: AUTO_CONTEXT_MAX_SCAN_ITEMS,
  });

  const fileMatches = matches
    .filter((match) => match.kind === "file" && isInspectableFile(match.relativePath))
    .slice(0, AUTO_CONTEXT_MAX_FILES);

  const blocks: string[] = [];
  for (const match of fileMatches) {
    const block = await readAutoContextFile(match);
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return undefined;

  const context = [
    "[KONTEKS FILE OTOMATIS RAKIT]",
    `Rakit otomatis menemukan ${blocks.length} file relevan dari prompt user.`,
    "Gunakan isi file di bawah untuk menentukan path dan membuat patch exact. Jangan minta user /tree, /find, /read, atau paste ulang jika informasi ini cukup.",
    "",
    blocks.join("\n\n"),
  ].join("\n");

  return context.length > AUTO_CONTEXT_TOTAL_MAX_CHARS
    ? `${safeSlice(context, AUTO_CONTEXT_TOTAL_MAX_CHARS)}\n... konteks file otomatis dipotong ...`
    : context;
}

async function collectInspectableFiles(absolutePath: string, rootPath: string, depth = 0, results: string[] = []): Promise<string[]> {
  if (depth > PROJECT_TREE_MAX_DEPTH || results.length >= INSPECT_MAX_FILES) return results;

  const stat = await fs.stat(absolutePath);

  if (stat.isFile()) {
    const relativePath = path.relative(rootPath, absolutePath) || path.basename(absolutePath);
    if (isInspectableFile(relativePath)) results.push(absolutePath);
    return results;
  }

  if (!stat.isDirectory()) return results;

  let entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries = entries
    .filter((entry) => !isIgnoredTreeEntry(entry.name))
    .sort((a, b) => {
      const priority = (name: string): number => {
        const lower = name.toLowerCase();
        if (lower === "package.json" || lower.startsWith("readme")) return 0;
        if (lower === "index.html" || lower === "index.ts" || lower === "index.js") return 1;
        if (lower.includes("app") || lower.includes("main") || lower.includes("style") || lower.includes("script")) return 2;
        return 3;
      };
      return priority(a.name) - priority(b.name)
        || Number(b.isDirectory()) - Number(a.isDirectory())
        || a.name.localeCompare(b.name);
    });

  for (const entry of entries) {
    if (results.length >= INSPECT_MAX_FILES) break;
    await collectInspectableFiles(path.join(absolutePath, entry.name), rootPath, depth + 1, results);
  }

  return results;
}

async function readInspectableFile(absolutePath: string, rootPath: string): Promise<string | undefined> {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size > INSPECT_MAX_FILE_BYTES) return undefined;

  const relativePath = normalizeDisplayPath(absolutePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const clippedContent = content.length > INSPECT_MAX_FILE_CHARS
    ? `${content.slice(0, INSPECT_MAX_FILE_CHARS)}\n... file dipotong ...`
    : content;
  const projectRelative = path.relative(rootPath, absolutePath).split(path.sep).join("/") || relativePath;

  return `--- ${projectRelative} ---\n${clippedContent}`;
}

export async function inspectProject(rawPath = "."): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  const stat = await fs.stat(resolved.absolutePath);
  const inspectRoot = stat.isDirectory() ? resolved.absolutePath : path.dirname(resolved.absolutePath);
  const tree = await buildProjectTreeText(rawPath, { color: false, maxDepth: PROJECT_TREE_MAX_DEPTH, maxItems: PROJECT_TREE_MAX_ITEMS });
  const files = stat.isFile()
    ? [resolved.absolutePath]
    : await collectInspectableFiles(resolved.absolutePath, inspectRoot);
  const fileBlocks: string[] = [];

  for (const filePath of files) {
    const block = await readInspectableFile(filePath, inspectRoot);
    if (block) fileBlocks.push(block);
  }

  const output = [
    `Inspect ${resolved.displayPath}`,
    `Tree (${tree.count} item${tree.truncated ? ", dipotong" : ""}):`,
    tree.lines.length > 0 ? tree.lines.join("\n") : "(kosong)",
    fileBlocks.length > 0 ? `\nFile penting (${fileBlocks.length}):\n${fileBlocks.join("\n\n")}` : "\nFile penting: (tidak ada file kecil yang cocok)",
  ].join("\n");

  return output.length > INSPECT_TOTAL_MAX_CHARS
    ? `${safeSlice(output, INSPECT_TOTAL_MAX_CHARS)}\n... inspect dipotong ...`
    : output;
}

export async function listDirectory(rawPath = "."): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  const entries = await fs.readdir(resolved.absolutePath, { withFileTypes: true });
  const sorted = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, MAX_LIST_ITEMS);

  const lines: string[] = [];

  for (const [index, entry] of sorted.entries()) {
    const isLast = index === sorted.length - 1;
    const connector = isLast ? icons.corner : icons.tee;
    const name = entry.isDirectory()
      ? ui.blue(ui.bold(`${entry.name}/`))
      : entry.name;

    lines.push(`  ${ui.dim(`${connector}${icons.dash}${icons.dash}`)} ${name}`);
  }

  if (entries.length > sorted.length) {
    lines.push(muted(`      ... ${entries.length - sorted.length} item lain tidak ditampilkan`));
  }

  const dirLabel = `${ui.bold("Isi")} ${code(resolved.displayPath)} ${ui.dim(`(${sorted.length} item)`)}`;
  return `${dirLabel}\n${lines.join("\n")}`;
}

export async function readTextFile(rawPath: string): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  const stat = await fs.stat(resolved.absolutePath);

  if (!stat.isFile()) {
    throw new Error(`Bukan file: ${resolved.displayPath}`);
  }

  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File terlalu besar untuk ditampilkan (${formatBytes(stat.size)}). Batas: ${formatBytes(MAX_READ_BYTES)}.`);
  }

  return fs.readFile(resolved.absolutePath, "utf8");
}

export async function writeTextFile(rawPath: string, content: string): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  const existed = await pathExists(resolved.absolutePath);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, content, "utf8");
  return `${existed ? "file diubah" : "file dibuat"}: ${resolved.displayPath}`;
}

export async function appendTextFile(rawPath: string, content: string): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.appendFile(resolved.absolutePath, content, "utf8");
  return `file ditambah: ${resolved.displayPath}`;
}

export async function deletePath(rawPath: string): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  await fs.rm(resolved.absolutePath, { recursive: true, force: false });
  return `dihapus: ${resolved.displayPath}`;
}

export async function makeDirectory(rawPath: string): Promise<string> {
  const resolved = await resolveSafePath(rawPath);
  await fs.mkdir(resolved.absolutePath, { recursive: true });
  return `folder dibuat: ${resolved.displayPath}`;
}

export async function readMultilineInput(question: QuestionFn): Promise<string | undefined> {
  info(`Masukkan isi. Ketik ${code(".save")} untuk simpan, ${code(".cancel")} untuk batal.`);
  const lines: string[] = [];

  while (true) {
    const line = await question("");

    if (line === ".save") {
      return `${lines.join("\n")}\n`;
    }

    if (line === ".cancel") {
      return undefined;
    }

    lines.push(line);
  }
}
