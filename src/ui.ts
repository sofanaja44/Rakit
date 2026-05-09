import * as clack from "@clack/prompts";
import pc from "picocolors";
import type { RakitTheme, TokenUsage } from "./types.js";

export { clack };
export const VERSION = "0.1.1";

// ── Picocolors styling helpers ─────────────────────────────────────────
export const ui = {
  bold: (text: string) => pc.bold(text),
  dim: (text: string) => pc.dim(text),
  red: (text: string) => pc.red(text),
  green: (text: string) => pc.green(text),
  yellow: (text: string) => pc.yellow(text),
  blue: (text: string) => pc.blue(text),
  magenta: (text: string) => pc.magenta(text),
  cyan: (text: string) => pc.cyan(text),
  gray: (text: string) => pc.gray(text),
  inverse: (text: string) => pc.inverse(text),
  underline: (text: string) => pc.underline(text),
};

// ── Icon set ───────────────────────────────────────────────────────────
export const icons = {
  ai: "✦",
  user: "›",
  ok: "✓",
  warn: "⚠",
  error: "✕",
  info: "ℹ",
  file: "◇",
  folder: "▣",
  arrow: "→",
  bullet: "•",
  dot: "·",
  bar: "│",
  dash: "─",
  tee: "├",
  corner: "└",
};

// ── ASCII Logo ─────────────────────────────────────────────────────────
const LOGO_L1 = "  █▀█ ▄▀█ █▄▀ █ ▀█▀";
const LOGO_L2 = "  █▀▄ █▀█ █ █ █  █ ";

export function printLogo(): void {
  line(ui.cyan(ui.bold(LOGO_L1)));
  line(ui.magenta(ui.bold(LOGO_L2)));
  line(ui.dim(`  AI Coding Assistant ${ui.gray(`v${VERSION}`)}`));
}

// ── Low-level output ───────────────────────────────────────────────────
export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function blank(): void {
  process.stdout.write("\n");
}

// ── Structured output helpers ──────────────────────────────────────────

export function header(title: string, subtitle?: string): void {
  const badge = ui.inverse(` ${title} `);
  line(`${badge}${subtitle ? ` ${ui.dim(subtitle)}` : ""}`);
}

export function section(title: string): void {
  line(ui.cyan(ui.bold(title)));
}

export function info(message: string): void {
  line(`${ui.cyan(icons.info)} ${message}`);
}

export function success(message: string): void {
  line(`${ui.green(icons.ok)} ${message}`);
}

export function warn(message: string): void {
  line(`${ui.yellow(icons.warn)} ${message}`);
}

export function error(message: string): void {
  process.stderr.write(`${ui.red(icons.error)} ${message}\n`);
}

export function keyValue(key: string, value: string): void {
  const lines = value.split(/\r?\n/);
  line(`  ${ui.dim(key.padEnd(14))} ${lines[0] ?? ""}`);
  for (const extraLine of lines.slice(1)) {
    line(`  ${ui.dim("".padEnd(14))} ${extraLine}`);
  }
}

export function command(commandText: string, description: string): string {
  return `  ${ui.cyan(commandText.padEnd(16))} ${ui.dim(description)}`;
}

export function promptLabel(): string {
  return `${ui.magenta(ui.bold("rakit"))}${ui.gray("❯")} `;
}

export function code(text: string): string {
  return ui.yellow(text);
}

export function muted(text: string): string {
  return ui.dim(text);
}

export function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export async function selectOption<T extends string>(options: {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
}): Promise<T | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;

  const selected = await clack.select({
    message: options.message,
    options: options.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
    })) as Parameters<typeof clack.select<T>>[0]["options"],
    initialValue: options.initialValue,
  });

  return clack.isCancel(selected) ? undefined : selected;
}

export type SwitchChoice = "accept" | "reject" | "detail";

export async function confirmSwitch(options: {
  message: string;
  defaultChoice?: "accept" | "reject";
  detailLabel?: string;
}): Promise<SwitchChoice | undefined> {
  const choices: SelectOption<SwitchChoice>[] = [
    { value: "accept", label: "Accept", hint: "lanjutkan" },
  ];

  if (options.detailLabel) {
    choices.push({ value: "detail", label: options.detailLabel, hint: "lihat detail dulu" });
  }

  choices.push({ value: "reject", label: "Reject", hint: "batalkan" });

  return selectOption({
    message: options.message,
    options: choices,
    initialValue: options.defaultChoice ?? "accept",
  });
}

// ── Divider ────────────────────────────────────────────────────────────
export function divider(width = 40): string {
  return ui.dim(icons.dash.repeat(width));
}

// ── Box (bordered note via clack) ──────────────────────────────────────
export function box(title: string, body: string): void {
  clack.note(body, title);
}

// ── Welcome screen (interactive chat) ──────────────────────────────────
type WelcomeOptions = {
  provider: string;
  model: string;
  folder: string;
};

export function welcomeScreen(options: WelcomeOptions): void {
  blank();
  printLogo();
  line(ui.dim(`  ${icons.dash.repeat(22)}`));
  blank();
  keyValue("provider", options.provider);
  keyValue("model", options.model);
  keyValue("folder", options.folder);
  blank();
  info(`Ketik ${code("/")} lalu Enter untuk Menu Interaktif, atau ${code("/help")} untuk melihat semua perintah.`);
  blank();
}

// ── Compact header (single prompt mode) ────────────────────────────────
export function compactHeader(provider: string, model: string): void {
  blank();
  line(`  ${ui.cyan(icons.ai)} ${ui.bold(ui.cyan("Rakit CLI"))} ${ui.dim(`v${VERSION}`)}`);
  keyValue("provider", provider);
  keyValue("model", model);
  blank();
}

// ── Live stream view (for AI token streaming) ──────────────────────────
export type LiveStreamEndOptions = {
  status?: "done" | "error";
  usage?: TokenUsage;
};

export type LiveStreamView = {
  onToken(token: string): void;
  onStatus(message: string): void;
  updateUsage(usage: TokenUsage): void;
  end(options?: LiveStreamEndOptions): { elapsed: number };
};

type LiveStreamOptions = {
  title?: string;
  model?: string;
  effort?: string;
  initialUsage?: TokenUsage;
  theme?: RakitTheme;
};

export function printResponseGate(title: string, body: string, subtitle?: string): void {
  const subtitleText = subtitle ? ` ${ui.dim(subtitle)}` : "";
  line(`${ui.dim("╭─")} ${ui.cyan(icons.ai)} ${ui.bold(title)}${subtitleText}`);

  for (const bodyLine of body.split(/\r?\n/)) {
    line(`${ui.dim(icons.bar)} ${bodyLine}`);
  }

  line(`${ui.dim("╰─")} ${ui.green(icons.ok)} ${ui.green("selesai")}`);
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1000) return String(Math.round(value));
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (value === 0) return "$0";
  if (value < 0.0001) return `<$0.0001`;
  return `$${value.toFixed(4)}`;
}

function formatContextUsage(usage: TokenUsage | undefined): string {
  if (!usage?.contextLimit) return "auto";

  const usedTokens = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  const percent = usage.contextLimit > 0 ? (usedTokens / usage.contextLimit) * 100 : 0;
  return `${percent.toFixed(1)}%/${formatTokenCount(usage.contextLimit)} (auto)`;
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripAnsiLength(value: string): number {
  return stripAnsi(value).length;
}

function truncateAnsi(value: string, maxLength: number): string {
  if (stripAnsiLength(value) <= maxLength) return value;
  return shortenMiddle(stripAnsi(value), maxLength);
}

function shortenMiddle(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);

  const edgeLength = Math.floor((maxLength - 1) / 2);
  const tailLength = maxLength - 1 - edgeLength;
  return `${value.slice(0, edgeLength)}…${value.slice(-tailLength)}`;
}

function formatUsageFooterLines(
  usage: TokenUsage | undefined,
  model: string | undefined,
  effort: string,
  theme: RakitTheme = "rich",
): [string, string] {
  const terminalWidth = process.stdout.columns || 100;
  const availableWidth = Math.max(40, terminalWidth - 4);
  const inputText = formatTokenCount(usage?.inputTokens);
  const outputText = formatTokenCount(usage?.outputTokens);
  const totalText = formatTokenCount(usage?.totalTokens);
  const costText = formatCost(usage?.costUsd);
  const contextText = formatContextUsage(usage);
  const compactTheme = theme === "compact" || theme === "minimal";
  const fixedUsageText = compactTheme
    ? `cwd  • in ${inputText} • out ${outputText} • total ${totalText} • ${costText}`
    : `path  • input ${inputText} • output ${outputText} • total ${totalText} • cost ${costText}`;
  const maxPathLength = Math.max(12, availableWidth - fixedUsageText.length);
  const pathText = shortenMiddle(process.cwd(), maxPathLength);
  const modelText = model ? shortenMiddle(model, Math.max(12, availableWidth - 26)) : undefined;

  if (theme === "minimal") {
    return [
      [pathText, `${inputText}/${outputText}/${totalText}`, costText].join(` ${ui.dim("•")} `),
      [contextText, modelText ? `${modelText} ${ui.dim("•")} ${effort}` : effort].join(` ${ui.dim("•")} `),
    ];
  }

  if (compactTheme) {
    return [
      [
        `${ui.dim("cwd")} ${pathText}`,
        `${ui.dim("in")} ${inputText}`,
        `${ui.dim("out")} ${outputText}`,
        `${ui.dim("total")} ${totalText}`,
        `${ui.dim("cost")} ${costText}`,
      ].join(` ${ui.dim("•")} `),
      [
        `${ui.dim("ctx")} ${contextText}`,
        modelText ? `${modelText} ${ui.dim("•")} ${effort}` : effort,
      ].join(` ${ui.dim("•")} `),
    ];
  }

  const usageLine = [
    `${ui.dim("path")} ${pathText}`,
    `${ui.dim("input")} ${inputText}`,
    `${ui.dim("output")} ${outputText}`,
    `${ui.dim("total")} ${totalText}`,
    `${ui.dim("cost")} ${costText}`,
  ].join(` ${ui.dim("•")} `);

  const modelLine = [
    `${ui.dim("context")} ${contextText}`,
    modelText ? `${modelText} ${ui.dim("•")} ${effort}` : effort,
  ].join(` ${ui.dim("•")} `);

  return [usageLine, modelLine];
}

function printUsageFooter(usage: TokenUsage | undefined, model: string | undefined, effort: string): void {
  const [usageLine, modelLine] = formatUsageFooterLines(usage, model, effort);
  line(`   ${usageLine}`);
  line(`   ${modelLine}`);
}

const PINNED_FOOTER_HEIGHT = 2;
const TUI_HEADER_HEIGHT = 3;
const PINNED_FOOTER_REFRESH_MS = 500;
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const CLEAR_SCREEN_HOME = "\x1b[2J\x1b[H";
const RESET_SCROLL_REGION = "\x1b[r";
const SHOW_CURSOR = "\x1b[?25h";
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";

type TerminalSize = {
  columns: number;
  rows: number;
};

type PinnedFooterState = {
  usage?: TokenUsage;
  model?: string;
  effort: string;
  theme: RakitTheme;
};

type TuiFrameState = {
  provider: string;
  model: string;
  folder: string;
  theme: RakitTheme;
};

let pinnedFooterActive = false;
let pinnedFooterState: PinnedFooterState = { effort: "medium", theme: "rich" };
let pinnedFooterExitHookInstalled = false;
let pinnedFooterTimer: NodeJS.Timeout | undefined;
let tuiFrameActive = false;
let tuiFrameState: TuiFrameState | undefined;

function getTerminalSize(): TerminalSize | undefined {
  if (!process.stdout.isTTY) return undefined;

  const stdout = process.stdout as NodeJS.WriteStream & {
    getWindowSize?: () => [number, number];
  };
  const windowSize = stdout.getWindowSize?.();
  const columns = process.stdout.columns ?? windowSize?.[0] ?? Number(process.env.COLUMNS);
  const rows = process.stdout.rows ?? windowSize?.[1] ?? Number(process.env.LINES);

  if (!Number.isFinite(columns) || !Number.isFinite(rows)) {
    return undefined;
  }

  return {
    columns: Math.floor(columns),
    rows: Math.floor(rows),
  };
}

function getPinnedHeaderHeight(): number {
  return tuiFrameActive ? TUI_HEADER_HEIGHT : 0;
}

function canUsePinnedFooter(): boolean {
  const size = getTerminalSize();
  return Boolean(size && size.rows > PINNED_FOOTER_HEIGHT + getPinnedHeaderHeight() + 4 && size.columns >= 40);
}

export function isPinnedFooterSupported(): boolean {
  return canUsePinnedFooter();
}

function applyPinnedFooterScrollRegion(): void {
  const size = getTerminalSize();
  if (!size) return;

  const contentTop = Math.max(1, getPinnedHeaderHeight() + 1);
  const contentBottom = Math.max(contentTop, size.rows - PINNED_FOOTER_HEIGHT);
  process.stdout.write(`${SAVE_CURSOR}\x1b[${contentTop};${contentBottom}r${RESTORE_CURSOR}`);
}

function enterTuiScreen(): void {
  process.stdout.write(`${ENTER_ALT_SCREEN}${CLEAR_SCREEN_HOME}${SHOW_CURSOR}`);
}

function leaveTuiScreen(): void {
  process.stdout.write(`${SAVE_CURSOR}${RESET_SCROLL_REGION}${RESTORE_CURSOR}${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
}

function drawPinnedFooter(): void {
  const size = getTerminalSize();
  if (!pinnedFooterActive || !size || !canUsePinnedFooter()) return;

  applyPinnedFooterScrollRegion();
  const footerStart = size.rows - PINNED_FOOTER_HEIGHT + 1;
  const [usageLine, modelLine] = formatUsageFooterLines(
    pinnedFooterState.usage,
    pinnedFooterState.model,
    pinnedFooterState.effort,
    pinnedFooterState.theme,
  );

  process.stdout.write(
    SAVE_CURSOR
      + `\x1b[${footerStart};1H\x1b[2K   ${usageLine}`
      + `\x1b[${footerStart + 1};1H\x1b[2K   ${modelLine}`
      + RESTORE_CURSOR,
  );
}

function drawTuiHeader(): void {
  const size = getTerminalSize();
  if (!tuiFrameActive || !tuiFrameState || !size) return;

  const title = ` ${icons.ai} Rakit ${ui.dim(`v${VERSION}`)} `;
  const left = `${ui.cyan(ui.bold(title))}${ui.dim("│")} ${tuiFrameState.provider} ${ui.dim("•")} ${shortenMiddle(tuiFrameState.model, 34)}`;
  const right = shortenMiddle(tuiFrameState.folder, Math.max(16, size.columns - stripAnsiLength(left) - 8));
  const headerLine = `${left} ${ui.dim("•")} ${ui.dim(right)}`;
  const helpLine = `${ui.dim(" /help commands  •  /menu palette  •  /models model  •  /run command  •  /exit quit")}`;
  const dividerLine = ui.dim(icons.dash.repeat(size.columns));

  process.stdout.write(
    SAVE_CURSOR
      + `\x1b[1;1H\x1b[2K${truncateAnsi(headerLine, size.columns)}`
      + `\x1b[2;1H\x1b[2K${truncateAnsi(helpLine, size.columns)}`
      + `\x1b[3;1H\x1b[2K${dividerLine}`
      + RESTORE_CURSOR,
  );
}

function redrawPinnedFrame(): void {
  if (tuiFrameActive) drawTuiHeader();
  if (pinnedFooterActive) drawPinnedFooter();
}

function handlePinnedFooterResize(): void {
  if (!pinnedFooterActive && !tuiFrameActive) return;
  redrawPinnedFrame();
}

function startPinnedFooterHeartbeat(): void {
  if (pinnedFooterTimer) return;

  pinnedFooterTimer = setInterval(() => {
    if (!pinnedFooterActive) return;
    drawPinnedFooter();
  }, PINNED_FOOTER_REFRESH_MS);
  pinnedFooterTimer.unref?.();
}

function stopPinnedFooterHeartbeat(): void {
  if (!pinnedFooterTimer) return;
  clearInterval(pinnedFooterTimer);
  pinnedFooterTimer = undefined;
}

function installPinnedFooterExitHook(): void {
  if (pinnedFooterExitHookInstalled) return;
  pinnedFooterExitHookInstalled = true;
  process.once("exit", () => {
    const shouldLeaveAltScreen = tuiFrameActive;
    resetPinnedFooter({ clear: true });
    if (shouldLeaveAltScreen && process.stdout.isTTY) {
      leaveTuiScreen();
    }
  });
}

export function resetPinnedFooter(options: { clear?: boolean } = {}): void {
  const wasActive = pinnedFooterActive;
  pinnedFooterActive = false;
  stopPinnedFooterHeartbeat();
  process.stdout.off("resize", handlePinnedFooterResize);

  if (!wasActive || !process.stdout.isTTY) return;

  const size = getTerminalSize();
  const footerStart = size ? size.rows - PINNED_FOOTER_HEIGHT + 1 : 1;
  process.stdout.write(`${SAVE_CURSOR}\x1b[r`);

  if (options.clear && size && size.rows > PINNED_FOOTER_HEIGHT) {
    process.stdout.write(
      `\x1b[${footerStart};1H\x1b[2K`
        + `\x1b[${footerStart + 1};1H\x1b[2K`,
    );
  }

  process.stdout.write(RESTORE_CURSOR);
}

export function updatePinnedFooter(
  options: { usage?: TokenUsage; model?: string; effort?: string; theme?: RakitTheme } = {},
): boolean {
  const nextState: PinnedFooterState = {
    usage: options.usage ?? pinnedFooterState.usage,
    model: options.model ?? pinnedFooterState.model,
    effort: options.effort ?? pinnedFooterState.effort,
    theme: options.theme ?? pinnedFooterState.theme,
  };

  if (!canUsePinnedFooter()) {
    pinnedFooterState = nextState;
    return false;
  }

  pinnedFooterState = nextState;

  if (!pinnedFooterActive) {
    pinnedFooterActive = true;
    installPinnedFooterExitHook();
    process.stdout.on("resize", handlePinnedFooterResize);
  }

  startPinnedFooterHeartbeat();
  redrawPinnedFrame();
  return true;
}

export type TuiFrameOptions = {
  provider: string;
  model: string;
  folder: string;
  theme: RakitTheme;
  usage?: TokenUsage;
};

export function startTuiFrame(options: TuiFrameOptions): boolean {
  const size = getTerminalSize();
  if (!size || !canUsePinnedFooter()) return false;

  tuiFrameActive = true;
  tuiFrameState = options;
  enterTuiScreen();
  updatePinnedFooter({ usage: options.usage, model: options.model, theme: options.theme });
  redrawPinnedFrame();
  process.stdout.write(`\x1b[${getPinnedHeaderHeight() + 1};1H${ui.dim("Rakit TUI aktif. Ketik pesan atau /help untuk mulai.")}\n\n`);
  return true;
}

export function updateTuiFrame(options: Partial<TuiFrameOptions>): void {
  if (!tuiFrameState) return;
  tuiFrameState = {
    ...tuiFrameState,
    ...options,
  };
  if (options.model || options.theme || options.usage) {
    updatePinnedFooter({ usage: options.usage, model: tuiFrameState.model, theme: tuiFrameState.theme });
  }
  redrawPinnedFrame();
}

export function stopTuiFrame(): void {
  const wasActive = tuiFrameActive;
  tuiFrameActive = false;
  tuiFrameState = undefined;
  resetPinnedFooter({ clear: true });

  if (wasActive && process.stdout.isTTY) {
    leaveTuiScreen();
  }
}

export function createLiveStreamView(options: LiveStreamOptions = {}): LiveStreamView {
  const { title = "Rakit", model, effort = "medium", theme = "rich" } = options;
  const useFooter = theme !== "no-footer";
  let started = false;
  let ended = false;
  let atLineStart = true;
  let usage = options.initialUsage;
  let lastStatus = "";
  let statusVisible = false;
  let lastStatusAt = 0;
  let lastFooterRender = 0;
  let footerTimer: NodeJS.Timeout | undefined;
  const startTime = Date.now();
  const sidePrefix = `${ui.dim(icons.bar)} `;

  const renderFooter = (force = false) => {
    if (!useFooter || !process.stdout.isTTY) return false;

    const now = Date.now();
    const elapsedSinceLastRender = now - lastFooterRender;

    if (!force && elapsedSinceLastRender < 80) {
      if (!footerTimer) {
        footerTimer = setTimeout(() => {
          footerTimer = undefined;
          lastFooterRender = Date.now();
          updatePinnedFooter({ usage, model, effort, theme });
        }, 80 - elapsedSinceLastRender);
      }
      return true;
    }

    if (footerTimer) {
      clearTimeout(footerTimer);
      footerTimer = undefined;
    }

    lastFooterRender = now;
    return updatePinnedFooter({ usage, model, effort, theme });
  };

  renderFooter(true);

  const writeStatus = (message: string) => {
    if (!useFooter || !process.stdout.isTTY) {
      line(`${ui.gray(icons.arrow)} ${muted(message)}`);
      return;
    }

    process.stdout.write(`\r\x1b[2K${ui.gray(icons.arrow)} ${muted(message)}`);
    statusVisible = true;
    renderFooter();
  };

  const clearStatus = () => {
    if (!statusVisible || !process.stdout.isTTY) return;
    process.stdout.write("\r\x1b[2K");
    statusVisible = false;
  };

  const ensureStarted = () => {
    if (started) return;
    started = true;
    clearStatus();
    const modelTag = model ? ` ${ui.dim(icons.dot)} ${ui.dim(model)}` : "";
    line(`${ui.dim("╭─")} ${ui.cyan(icons.ai)} ${ui.bold(title)}${modelTag}`);
    renderFooter(true);
  };

  const writeTokenWithGate = (token: string) => {
    for (const part of token.split(/(\r\n|\n|\r)/)) {
      if (!part) continue;

      if (part === "\n" || part === "\r" || part === "\r\n") {
        if (atLineStart) {
          process.stdout.write(sidePrefix);
        }
        process.stdout.write("\n");
        atLineStart = true;
        continue;
      }

      if (atLineStart) {
        process.stdout.write(sidePrefix);
        atLineStart = false;
      }

      process.stdout.write(part);
    }
  };

  return {
    onToken(token: string): void {
      if (!token || ended) return;
      ensureStarted();
      writeTokenWithGate(token);
      renderFooter();
    },
    onStatus(message: string): void {
      if (!message || started) return;
      const now = Date.now();
      if (message === lastStatus && now - lastStatusAt < 1_000) return;
      lastStatus = message;
      lastStatusAt = now;
      writeStatus(message);
    },
    updateUsage(nextUsage: TokenUsage): void {
      usage = {
        ...usage,
        ...nextUsage,
      };
      renderFooter();
    },
    end(endOptions: LiveStreamEndOptions = {}): { elapsed: number } {
      const elapsed = (Date.now() - startTime) / 1000;
      if (footerTimer) {
        clearTimeout(footerTimer);
        footerTimer = undefined;
      }
      clearStatus();

      if (endOptions.usage) {
        usage = { ...usage, ...endOptions.usage };
      }

      if (!started || ended) {
        ended = true;
        renderFooter(true);
        return { elapsed };
      }

      ended = true;

      if (!atLineStart) {
        process.stdout.write("\n");
      }

      const isError = endOptions.status === "error";
      const statusIcon = isError ? ui.red(icons.error) : ui.green(icons.ok);
      const statusText = isError ? ui.red("gagal") : ui.green("selesai");
      line(`${ui.dim("╰─")} ${statusIcon} ${statusText} ${ui.dim(`${icons.dot} ${elapsed.toFixed(1)}s`)}`);

      if (!isError) {
        if (!renderFooter(true)) {
          printUsageFooter(usage, model, effort);
        }
      }

      return { elapsed };
    },
  };
}

// ── Spinner ────────────────────────────────────────────────────────────
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function withSpinner<T>(message: string, task: Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    info(message);
    try {
      return await task;
    } catch (errorValue) {
      error(message);
      throw errorValue;
    }
  }

  let index = 0;
  process.stdout.write(`${ui.cyan(spinnerFrames[index])} ${message}`);

  const timer = setInterval(() => {
    index = (index + 1) % spinnerFrames.length;
    process.stdout.write(`\r${ui.cyan(spinnerFrames[index])} ${message}`);
  }, 80);

  try {
    const result = await task;
    clearInterval(timer);
    process.stdout.write(`\r${ui.green(icons.ok)} ${message}\n\n`);
    return result;
  } catch (errorValue) {
    clearInterval(timer);
    process.stdout.write(`\r${ui.red(icons.error)} ${message}\n\n`);
    throw errorValue;
  }
}

// ── Goodbye ────────────────────────────────────────────────────────────
export function goodbye(message = "Sampai jumpa! 👋"): void {
  clack.outro(message);
}

// ── Shared yes/no parsing ──────────────────────────────────────────────
export function parseYesNo(answer: string): boolean | undefined {
  const value = answer.trim().toLowerCase();

  if (!value) return undefined;
  if (["y", "yes", "ya", "iya"].includes(value)) return true;
  if (["n", "no", "tidak", "t"].includes(value)) return false;

  return undefined;
}

type QuestionFnForYesNo = (query: string) => Promise<string>;

export async function askYesNo(question: QuestionFnForYesNo, prompt: string, defaultValue: boolean): Promise<boolean> {
  while (true) {
    const answer = await question(prompt);
    const parsed = parseYesNo(answer);

    if (parsed === undefined && answer.trim() === "") {
      return defaultValue;
    }

    if (parsed !== undefined) {
      return parsed;
    }

    info("Jawab y atau n.");
  }
}

// ── Safe string slice (multi-byte aware) ───────────────────────────────
/**
 * Safely truncate a string to `maxChars` by finding a valid code-point boundary.
 * Prevents splitting a surrogate pair mid-character which would corrupt the string.
 */
export function safeSlice(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Avoid slicing inside a surrogate pair
  let end = maxChars;
  if (end > 0 && end < value.length) {
    const code = value.charCodeAt(end - 1);
    // High surrogate: 0xD800–0xDBFF
    if (code >= 0xD800 && code <= 0xDBFF) {
      end--;
    }
  }
  return value.slice(0, end);
}
