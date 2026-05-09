import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";
import type { ChatMessage, RakitConfig } from "./types.js";

export type ProjectSession = {
  version: 1;
  projectPath: string;
  provider: string;
  model: string;
  updatedAt: string;
  messages: ChatMessage[];
};

export type ProjectSessionSummary = {
  path: string;
  exists: boolean;
  updatedAt?: string;
  messageCount?: number;
  model?: string;
};

const SESSION_DIR = path.join(CONFIG_DIR, "sessions");

function projectHash(projectPath = process.cwd()): string {
  return createHash("sha256").update(path.resolve(projectPath)).digest("hex").slice(0, 16);
}

export function getProjectSessionPath(projectPath = process.cwd()): string {
  return path.join(SESSION_DIR, `${projectHash(projectPath)}.json`);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<ChatMessage>;
  return (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string"
    && message.content.length > 0;
}

export async function loadProjectSession(projectPath = process.cwd()): Promise<ProjectSession | undefined> {
  const sessionPath = getProjectSessionPath(projectPath);

  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectSession>;

    if (!Array.isArray(parsed.messages)) {
      return undefined;
    }

    return {
      version: 1,
      projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : path.resolve(projectPath),
      provider: typeof parsed.provider === "string" ? parsed.provider : "unknown",
      model: typeof parsed.model === "string" ? parsed.model : "unknown",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      messages: parsed.messages.filter(isChatMessage),
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function saveProjectSession(messages: ChatMessage[], config: RakitConfig, projectPath = process.cwd()): Promise<string> {
  const sessionPath = getProjectSessionPath(projectPath);
  const sessionMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const session: ProjectSession = {
    version: 1,
    projectPath: path.resolve(projectPath),
    provider: config.provider,
    model: config.model,
    updatedAt: new Date().toISOString(),
    messages: sessionMessages,
  };

  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return sessionPath;
}

export async function clearProjectSession(projectPath = process.cwd()): Promise<void> {
  await fs.rm(getProjectSessionPath(projectPath), { force: true });
}

export async function getProjectSessionSummary(projectPath = process.cwd()): Promise<ProjectSessionSummary> {
  const sessionPath = getProjectSessionPath(projectPath);
  const session = await loadProjectSession(projectPath);

  if (!session) {
    return { path: sessionPath, exists: false };
  }

  return {
    path: sessionPath,
    exists: true,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    model: session.model,
  };
}
