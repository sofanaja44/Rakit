import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";

export const AUTH_FILE = path.join(CONFIG_DIR, "auth.json");

export type OpenAICodexCredentials = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

type AuthFile = {
  "openai-codex"?: OpenAICodexCredentials;
};

export function getAuthPath(): string {
  return AUTH_FILE;
}

async function readAuthFile(): Promise<AuthFile> {
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Isi auth harus berupa object JSON.");
    }

    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Auth tidak valid: ${AUTH_FILE}`);
    }

    throw error;
  }
}

async function saveAuthFile(auth: AuthFile): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  try {
    await fs.chmod(AUTH_FILE, 0o600);
  } catch {
    // Windows tidak selalu mendukung chmod seperti Unix. Aman untuk diabaikan.
  }
}

function isOpenAICodexCredentials(value: unknown): value is OpenAICodexCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const credential = value as Partial<OpenAICodexCredentials>;
  return credential.type === "oauth"
    && typeof credential.access === "string"
    && credential.access.length > 0
    && typeof credential.refresh === "string"
    && credential.refresh.length > 0
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires)
    && typeof credential.accountId === "string"
    && credential.accountId.length > 0;
}

export async function getOpenAICodexCredentials(): Promise<OpenAICodexCredentials | undefined> {
  const auth = await readAuthFile();
  const credentials = auth["openai-codex"];

  return isOpenAICodexCredentials(credentials) ? credentials : undefined;
}

export async function setOpenAICodexCredentials(credentials: OpenAICodexCredentials): Promise<void> {
  const auth = await readAuthFile();
  auth["openai-codex"] = credentials;
  await saveAuthFile(auth);
}

export async function clearOpenAICodexCredentials(): Promise<void> {
  const auth = await readAuthFile();
  delete auth["openai-codex"];
  await saveAuthFile(auth);
}

export async function hasOpenAICodexCredentials(): Promise<boolean> {
  return (await getOpenAICodexCredentials()) !== undefined;
}
