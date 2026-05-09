import { highlight, type Theme } from "cli-highlight";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { ui } from "./ui.js";

// ── Configure marked with terminal renderer ────────────────────────────
marked.use(
  markedTerminal({
    showSectionPrefix: false,
    tab: 2,
  }) as any,
);

// ── Render markdown to terminal-friendly output ────────────────────────
export function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    if (typeof rendered !== "string") return text;
    // Remove trailing newlines from marked output
    return rendered.replace(/\n+$/, "");
  } catch {
    return text;
  }
}

// ── File extension to language map ─────────────────────────────────────
const EXT_LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".md": "markdown",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".xml": "xml",
  ".sql": "sql",
  ".graphql": "graphql",
  ".dockerfile": "dockerfile",
  ".env": "ini",
};

export function detectLanguage(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();

  // Check exact filenames
  if (lower.endsWith("dockerfile")) return "dockerfile";
  if (lower.endsWith("makefile")) return "makefile";

  // Check extension
  const dotIndex = lower.lastIndexOf(".");
  if (dotIndex === -1) return undefined;

  const ext = lower.slice(dotIndex);
  return EXT_LANG_MAP[ext];
}

// ── VS Code-like terminal theme. Uses our own ANSI helpers so colors stay
// consistent even when cli-highlight/chalk would otherwise output plain text.
const SYNTAX_THEME: Theme = {
  default: (text) => text,
  keyword: (text) => ui.magenta(text),
  built_in: (text) => ui.cyan(text),
  type: (text) => ui.cyan(text),
  literal: (text) => ui.blue(text),
  number: (text) => ui.yellow(text),
  regexp: (text) => ui.red(text),
  string: (text) => ui.green(text),
  subst: (text) => text,
  symbol: (text) => ui.yellow(text),
  class: (text) => ui.yellow(text),
  function: (text) => ui.blue(text),
  title: (text) => ui.yellow(text),
  params: (text) => text,
  comment: (text) => ui.gray(text),
  doctag: (text) => ui.gray(text),
  meta: (text) => ui.gray(text),
  attribute: (text) => ui.cyan(text),
  name: (text) => ui.red(text),
  tag: (text) => ui.red(text),
  variable: (text) => ui.cyan(text),
  bullet: (text) => ui.yellow(text),
  code: (text) => ui.green(text),
  emphasis: (text) => ui.underline(text),
  strong: (text) => ui.bold(text),
  link: (text) => ui.underline(ui.cyan(text)),
  quote: (text) => ui.gray(text),
  'selector-tag': (text) => ui.red(text),
  'selector-id': (text) => ui.yellow(text),
  'selector-class': (text) => ui.yellow(text),
  'selector-attr': (text) => ui.cyan(text),
  'selector-pseudo': (text) => ui.magenta(text),
  'template-tag': (text) => ui.gray(text),
  'template-variable': (text) => ui.cyan(text),
  addition: (text) => ui.green(text),
  deletion: (text) => ui.red(text),
};

// ── Highlight code with cli-highlight ──────────────────────────────────
export function highlightCode(code: string, language?: string): string {
  try {
    return highlight(code, {
      language: language ?? undefined,
      ignoreIllegals: true,
      theme: SYNTAX_THEME,
    });
  } catch {
    try {
      return highlight(code, {
        ignoreIllegals: true,
        languageSubset: ["typescript", "javascript", "json", "html", "css", "bash", "python"],
        theme: SYNTAX_THEME,
      });
    } catch {
      return code;
    }
  }
}

// ── Highlight a file's content based on its path ───────────────────────
export function highlightFile(content: string, filePath: string): string {
  const lang = detectLanguage(filePath);
  if (!lang) return content;
  return highlightCode(content, lang);
}
