import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import os from "node:os";
import {
  getOpenAICodexCredentials,
  setOpenAICodexCredentials,
  type OpenAICodexCredentials,
} from "../auth.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "../config.js";
import type { ChatMessage, ProviderResponse, RakitConfig, TokenUsage } from "../types.js";
import { parseSseJsonStream } from "./sse.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`;
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_HOST = process.env.RAKIT_OAUTH_CALLBACK_HOST || "localhost";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export type OpenAICodexLoginCallbacks = {
  onAuth(auth: { url: string; instructions: string }): void;
  onPrompt(prompt: string): Promise<string>;
  onProgress?(message: string): void;
};

type StreamCallbacks = {
  onToken?(token: string): void;
  onStatus?(message: string): void;
  onUsage?(usage: TokenUsage): void;
};

type OAuthServer = {
  listening: boolean;
  waitForCode(): Promise<string | null>;
  close(): void;
};

type ParsedAuthorizationInput = {
  code?: string;
  state?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type CodexUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type CodexEvent = Record<string, unknown> & {
  type?: string;
  delta?: string;
  message?: string;
  code?: string;
  response?: {
    usage?: CodexUsage;
    error?: {
      code?: string;
      message?: string;
      type?: string;
      plan_type?: string;
      resets_at?: number;
    };
    output?: unknown[];
  };
  item?: {
    type?: string;
    name?: string;
    content?: Array<{
      type?: string;
      text?: string;
      refusal?: string;
    }>;
  };
};

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];

  if (!auth || typeof auth !== "object") {
    return undefined;
  }

  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function createAuthorizationUrl(state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "rakit");
  return url.toString();
}

function oauthSuccessHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rakit Login</title></head><body><h1>Login berhasil</h1><p>OpenAI Codex sudah terhubung. Tab ini bisa ditutup.</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oauthErrorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Rakit Login</title></head><body><h1>Login gagal</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "rundll32"
      : "xdg-open";
  const args = process.platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.on("error", () => {
    // Browser gagal dibuka otomatis tidak fatal karena URL tetap ditampilkan.
  });
  child.unref();
}

function parseAuthorizationInput(input: string): ParsedAuthorizationInput {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Bukan URL lengkap.
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  const paramsInput = value.replace(/^[?#]/, "");

  if (paramsInput.includes("code=")) {
    const params = new URLSearchParams(paramsInput);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

async function startLocalOAuthServer(expectedState: string): Promise<OAuthServer> {
  let server: Server | undefined;
  let settleWait: ((code: string | null) => void) | undefined;

  const waitForCodePromise = new Promise<string | null>((resolve) => {
    let settled = false;
    settleWait = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });

  return new Promise((resolve) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "", "http://localhost");

        if (url.pathname !== "/auth/callback") {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Callback route tidak ditemukan."));
          return;
        }

        if (url.searchParams.get("state") !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("State OAuth tidak cocok."));
          settleWait?.(null);
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(oauthErrorHtml("Authorization code tidak ditemukan."));
          settleWait?.(null);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthSuccessHtml());
        settleWait?.(code);
      } catch {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(oauthErrorHtml("Terjadi error saat memproses callback."));
        settleWait?.(null);
      }
    });

    server
      .listen(1455, CALLBACK_HOST, () => {
        resolve({
          listening: true,
          waitForCode: () => waitForCodePromise,
          close: () => server?.close(),
        });
      })
      .on("error", () => {
        settleWait?.(null);
        resolve({
          listening: false,
          waitForCode: async () => null,
          close: () => {
            try {
              server?.close();
            } catch {
              // ignore
            }
          },
        });
      });
  });
}

async function exchangeAuthorizationCode(code: string, verifier: string): Promise<OpenAICodexCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await response.json().catch(() => ({})) as TokenResponse;

  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Token exchange gagal (${response.status})`);
  }

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Token response OpenAI Codex tidak valid.");
  }

  const accountId = getAccountId(data.access_token);
  if (!accountId) {
    throw new Error("Gagal membaca account ID dari token OpenAI Codex.");
  }

  return {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

async function refreshOpenAICodexToken(refreshToken: string): Promise<OpenAICodexCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json().catch(() => ({})) as TokenResponse;

  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Refresh token gagal (${response.status})`);
  }

  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Refresh token response OpenAI Codex tidak valid.");
  }

  const accountId = getAccountId(data.access_token);
  if (!accountId) {
    throw new Error("Gagal membaca account ID dari token OpenAI Codex.");
  }

  return {
    type: "oauth",
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

export async function loginOpenAICodex(callbacks: OpenAICodexLoginCallbacks): Promise<OpenAICodexCredentials> {
  const { verifier, challenge } = generatePKCE();
  const state = createState();
  const authUrl = createAuthorizationUrl(state, challenge);
  const server = await startLocalOAuthServer(state);

  callbacks.onAuth({
    url: authUrl,
    instructions: server.listening
      ? "Browser akan dibuka. Selesaikan login, lalu Rakit akan lanjut otomatis."
      : "Port callback tidak tersedia. Login di browser, lalu paste authorization code atau full redirect URL.",
  });
  openBrowser(authUrl);

  try {
    let code: string | undefined;

    if (server.listening) {
      callbacks.onProgress?.("Menunggu callback dari browser...");
      const callbackCode = await Promise.race([server.waitForCode(), wait(45_000)]);
      code = callbackCode ?? undefined;
    }

    if (!code) {
      const input = await callbacks.onPrompt("Paste authorization code/full redirect URL OpenAI: ");
      const parsed = parseAuthorizationInput(input);

      if (parsed.state && parsed.state !== state) {
        throw new Error("State OAuth tidak cocok.");
      }

      code = parsed.code;
    }

    if (!code) {
      throw new Error("Authorization code OpenAI tidak ditemukan.");
    }

    return exchangeAuthorizationCode(code, verifier);
  } finally {
    server.close();
  }
}

async function getValidOpenAICodexCredentials(): Promise<OpenAICodexCredentials> {
  const credentials = await getOpenAICodexCredentials();

  if (!credentials) {
    throw new Error("OpenAI Codex belum login. Jalankan: rakit login lalu pilih OpenAI Codex.");
  }

  if (credentials.expires > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return credentials;
  }

  const refreshed = await refreshOpenAICodexToken(credentials.refresh);
  await setOpenAICodexCredentials(refreshed);
  return refreshed;
}

function toCodexInput(messages: ChatMessage[]): unknown[] {
  const inputMessages: unknown[] = [];
  let assistantIndex = 0;

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      inputMessages.push({
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }

    inputMessages.push({
      type: "message",
      id: `msg_${assistantIndex++}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    });
  }

  return inputMessages;
}

function buildCodexRequestBody(messages: ChatMessage[], config: RakitConfig): Record<string, unknown> {
  const inputMessages = toCodexInput(messages);

  if (inputMessages.length === 0) {
    throw new Error("Prompt kosong.");
  }

  return {
    model: config.model || OPENAI_CODEX_DEFAULT_MODEL,
    store: false,
    stream: true,
    instructions: config.systemPrompt,
    input: inputMessages,
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
}

function buildCodexHeaders(credentials: OpenAICodexCredentials): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${credentials.access}`);
  headers.set("chatgpt-account-id", credentials.accountId);
  headers.set("originator", "rakit");
  headers.set("User-Agent", `rakit (${os.platform()} ${os.release()}; ${os.arch()})`);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("Accept", "text/event-stream");
  headers.set("Content-Type", "application/json");
  return headers;
}

function parseSseEventStream(response: Response): AsyncGenerator<CodexEvent> {
  return parseSseJsonStream<CodexEvent>(response, { ignoreInvalidJson: true });
}

async function parseSseEvents(response: Response): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];

  for await (const event of parseSseEventStream(response)) {
    events.push(event);
  }

  return events;
}

function extractOutputTextFromEvents(events: CodexEvent[]): string {
  let deltaText = "";
  let finalText = "";

  for (const event of events) {
    if (event.type === "error") {
      throw new Error(`Codex error: ${event.message || event.code || "unknown error"}`);
    }

    if (event.type === "response.failed") {
      const error = event.response?.error;
      throw new Error(error?.message || error?.code || "Codex response failed");
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltaText += event.delta;
      continue;
    }

    if (event.type === "response.output_item.done" && event.item?.type === "message") {
      const text = event.item.content
        ?.map((part) => part.type === "output_text" ? part.text ?? "" : part.refusal ?? "")
        .join("") ?? "";

      if (text) {
        finalText = text;
      }
    }
  }

  return (finalText || deltaText).trim();
}

async function buildCodexHttpError(response: Response): Promise<Error> {
  const raw = await response.text().catch(() => "");
  let message = raw || response.statusText || "Request failed";
  let code = "";
  let plan = "";
  let resetText = "";

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        message?: string;
        code?: string;
        type?: string;
        plan_type?: string;
        resets_at?: number;
      };
    };
    const error = parsed.error;

    if (error) {
      message = error.message || message;
      code = error.code || error.type || "";
      plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";

      if (typeof error.resets_at === "number") {
        const minutes = Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60_000));
        resetText = ` Coba lagi sekitar ${minutes} menit lagi.`;
      }
    }
  } catch {
    // raw bukan JSON.
  }

  if (response.status === 401 || response.status === 403) {
    return new Error(`OpenAI Codex auth gagal: ${message}. Jalankan ulang: rakit login`);
  }

  if (response.status === 429 || /usage_limit|rate_limit/i.test(code)) {
    return new Error(`Limit ChatGPT/Codex tercapai${plan}.${resetText || " Coba lagi nanti."}`);
  }

  return new Error(`OpenAI Codex error ${response.status}: ${message}`);
}

async function sendCodexRequest(credentials: OpenAICodexCredentials, messages: ChatMessage[], config: RakitConfig): Promise<Response> {
  return fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: buildCodexHeaders(credentials),
    body: JSON.stringify(buildCodexRequestBody(messages, config)),
  });
}

type CodexTextState = {
  deltaText: string;
  finalText: string;
  usage?: TokenUsage;
  sawReasoning: boolean;
  sawMessage: boolean;
  sawFunctionCall: boolean;
};

function toTokenUsage(usage: CodexUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;

  const result: TokenUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    contextLimit: 272_000,
  };

  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function handleCodexStreamEvent(event: CodexEvent, state: CodexTextState, callbacks: StreamCallbacks): void {
  if (event.type === "error") {
    throw new Error(`Codex error: ${event.message || event.code || "unknown error"}`);
  }

  if (event.type === "response.failed") {
    const error = event.response?.error;
    throw new Error(error?.message || error?.code || "Codex response failed");
  }

  const eventUsage = toTokenUsage(event.response?.usage);
  if (eventUsage) {
    state.usage = eventUsage;
    callbacks.onUsage?.(eventUsage);
  }

  if (event.type === "response.output_item.added") {
    if (event.item?.type === "reasoning" && !state.sawReasoning) {
      state.sawReasoning = true;
      callbacks.onStatus?.("Codex sedang menyusun reasoning...");
    }

    if (event.item?.type === "message" && !state.sawMessage) {
      state.sawMessage = true;
      callbacks.onStatus?.("Codex mulai menulis jawaban...");
    }

    if (event.item?.type === "function_call" && !state.sawFunctionCall) {
      state.sawFunctionCall = true;
      callbacks.onStatus?.(`Codex menyiapkan aksi ${event.item.name ?? "function"}...`);
    }
  }

  if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta") && typeof event.delta === "string") {
    state.deltaText += event.delta;
    callbacks.onToken?.(event.delta);
    return;
  }

  if (event.type === "response.output_item.done" && event.item?.type === "message") {
    const text = event.item.content
      ?.map((part) => part.type === "output_text" ? part.text ?? "" : part.refusal ?? "")
      .join("") ?? "";

    if (text) {
      state.finalText = text;
    }
  }
}

export async function chatWithOpenAICodex(messages: ChatMessage[], config: RakitConfig): Promise<string> {
  let credentials = await getValidOpenAICodexCredentials();
  let response = await sendCodexRequest(credentials, messages, config);

  if (response.status === 401 || response.status === 403) {
    const refreshed = await refreshOpenAICodexToken(credentials.refresh);
    await setOpenAICodexCredentials(refreshed);
    credentials = refreshed;
    response = await sendCodexRequest(credentials, messages, config);
  }

  if (!response.ok) {
    throw await buildCodexHttpError(response);
  }

  const events = await parseSseEvents(response);
  const answer = extractOutputTextFromEvents(events);

  if (!answer) {
    throw new Error("Response OpenAI Codex tidak berisi pesan assistant.");
  }

  return answer;
}

export async function streamOpenAICodex(
  messages: ChatMessage[],
  config: RakitConfig,
  callbacks: StreamCallbacks = {},
): Promise<ProviderResponse> {
  callbacks.onStatus?.("Menyiapkan token OpenAI Codex...");
  let credentials = await getValidOpenAICodexCredentials();

  callbacks.onStatus?.("Menghubungi OpenAI Codex...");
  let response = await sendCodexRequest(credentials, messages, config);

  if (response.status === 401 || response.status === 403) {
    callbacks.onStatus?.("Token kedaluwarsa, refresh otomatis...");
    const refreshed = await refreshOpenAICodexToken(credentials.refresh);
    await setOpenAICodexCredentials(refreshed);
    credentials = refreshed;
    response = await sendCodexRequest(credentials, messages, config);
  }

  if (!response.ok) {
    throw await buildCodexHttpError(response);
  }

  callbacks.onStatus?.("Menerima respons live dari Codex...");

  const state: CodexTextState = {
    deltaText: "",
    finalText: "",
    usage: undefined,
    sawReasoning: false,
    sawMessage: false,
    sawFunctionCall: false,
  };

  for await (const event of parseSseEventStream(response)) {
    handleCodexStreamEvent(event, state, callbacks);
  }

  const answer = (state.finalText || state.deltaText).trim();

  if (!answer) {
    throw new Error("Response OpenAI Codex tidak berisi pesan assistant.");
  }

  return { content: answer, usage: state.usage };
}
