/**
 * DGAJ15: the `/v1/*` client of the live mode + the API key file.
 *
 *  - Base `https://degenly.app`. `DEGENLY_API_BASE` may change it ONLY to another `https://` origin (no user
 *    info, no path, no query); any other scheme / shape → BAD_API_BASE before any request.
 *  - Every request is signed by the agent wallet (./sign.ts, server rule degenly/src/edge/botApi.ts:286-312):
 *    x-degenly-key = the plain API key, x-degenly-ts, x-degenly-sig. The signed path is exactly what the server
 *    reads (`url.pathname + url.search`); a path that would be rewritten by URL parsing is refused (BAD_PATH).
 *  - `redirect: "error"`: a redirect never carries the key or a signature to another place.
 *  - Server refusals come back as is: the server's stable `error` code (SPEND_LIMIT, SPEND_LIMIT_NOT_SET,
 *    TOKEN_BLOCKED, API_BUDGET_EXHAUSTED, API_SEATS_FULL, KEY_INVALID, …) + its scalar fields (scope,
 *    limitLamports, …) + Retry-After. 404 = the Bot API is off: "Live trading is not available yet."
 *  - API key file `~/.degenly/credentials.json` (POSIX 0600, dir 0700). The key is never printed; only its first
 *    12 chars (the server's own display prefix, apiConstants.ts:26, not enough to use the key).
 * No telemetry: the only requests are the ones a command asks for.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./api.js";
import { degenlyDir } from "./keys.js";
import { cleanText } from "./sanitize.js";
import { API_KEY_HEADER, API_SIG_HEADER, API_TS_HEADER, signApiRequest, type Signer } from "./sign.js";

export const DEFAULT_API_BASE = "https://degenly.app";
export const LIVE_REQUEST_TIMEOUT_MS = 20_000;
export const CREDENTIALS_FILE_NAME = "credentials.json";
export const CREDENTIALS_PATH_TEXT = "~/.degenly/credentials.json";
/** The server answers every `/v1/*` path 404 while the Bot API is off (botApi.ts:627). Do not promise more. */
export const LIVE_NOT_AVAILABLE = "Live trading is not available yet.";
/** Must equal `API_KEY_PREFIX` / `API_KEY_DISPLAY_CHARS` in degenly/src/config/apiConstants.ts:23, :26. */
export const API_KEY_PREFIX = "dgk_";
export const API_KEY_DISPLAY_CHARS = 12;
/** A pasted key file / stdin larger than this is not a key. */
export const KEY_INPUT_MAX_BYTES = 4096;

const POSIX = process.platform !== "win32";
const CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED = new Set(["ok", "mode", "note", "error", "hint", "status", "retryAfterMs"]);

// ---- API base ----------------------------------------------------------------------------------

export function resolveApiBase(env: Readonly<Record<string, string | undefined>>): { ok: true; base: string } | { ok: false; error: "BAD_API_BASE" } {
  const v = env.DEGENLY_API_BASE;
  if (v === undefined || v === "") return { ok: true, base: DEFAULT_API_BASE };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: "BAD_API_BASE" };
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) {
    return { ok: false, error: "BAD_API_BASE" };
  }
  return { ok: true, base: u.origin };
}

// ---- API key file ------------------------------------------------------------------------------

/** Same shape check as the server (degenly/src/api/keyStore.ts:122-124). */
export function plausibleApiKey(text: string): boolean {
  return text.startsWith(API_KEY_PREFIX) && text.length >= API_KEY_PREFIX.length + 40 && text.length <= API_KEY_PREFIX.length + 50 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(text.slice(API_KEY_PREFIX.length));
}

export function credentialsPath(home: string): string {
  return join(degenlyDir(home), CREDENTIALS_FILE_NAME);
}

/** `login`: stores the key (replaces an older one: the wallet file is what must never be overwritten). */
export function saveCredentials(home: string, apiKey: string): boolean {
  try {
    mkdirSync(degenlyDir(home), { recursive: true, mode: 0o700 });
    if (POSIX) chmodSync(degenlyDir(home), 0o700);
    writeFileSync(credentialsPath(home), JSON.stringify({ v: 1, apiKey }), { mode: 0o600 });
    if (POSIX) chmodSync(credentialsPath(home), 0o600);
    return true;
  } catch {
    return false;
  }
}

export function loadCredentials(home: string): { ok: true; apiKey: string } | { ok: false; error: "NOT_LOGGED_IN" | "CREDENTIALS_CORRUPT" } {
  const file = credentialsPath(home);
  if (!existsSync(file)) return { ok: false, error: "NOT_LOGGED_IN" };
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const k = (v as Record<string, unknown>).apiKey;
      if (typeof k === "string" && plausibleApiKey(k)) return { ok: true, apiKey: k };
    }
  } catch {
    // fall through
  }
  return { ok: false, error: "CREDENTIALS_CORRUPT" };
}

// ---- client ------------------------------------------------------------------------------------

export type LiveResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; error: string; status: number; retryAfterMs?: number; fields: Record<string, string | number | boolean> };

export interface LiveClientDeps {
  fetch: FetchLike;
  base: string;
  apiKey: string;
  signer: Signer;
  now: () => number;
}

export interface LiveClient {
  /** `pathWithQuery` starts with `/v1/`; `body` (JSON text) is sent and hashed byte for byte. */
  request(method: "GET" | "POST", pathWithQuery: string, body?: string): Promise<LiveResult>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function retryAfterMs(r: Response): number | undefined {
  const h = r.headers.get("retry-after");
  if (h === null) return undefined;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

/** The server's scalar fields (scope, limitLamports, reason, …), cleaned; nested values are dropped. */
function scalarFields(body: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(body)) {
    if (RESERVED.has(k) || !FIELD_RE.test(k)) continue;
    if (typeof v === "string") out[k] = cleanText(v, 200);
    else if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const fail = (error: string, status: number, fields: Record<string, string | number | boolean> = {}, after?: number): LiveResult => ({
  ok: false,
  error,
  status,
  fields,
  ...(after !== undefined ? { retryAfterMs: after } : {}),
});

export function createLiveClient(deps: LiveClientDeps): LiveClient {
  return {
    async request(method, pathWithQuery, body) {
      if (!pathWithQuery.startsWith("/v1/")) return fail("BAD_PATH", 0);
      let url: URL;
      try {
        url = new URL(pathWithQuery, deps.base);
      } catch {
        return fail("BAD_PATH", 0);
      }
      // what is signed must be what the server reads: same origin, no rewrite by the URL parser
      if (url.origin !== deps.base || url.pathname + url.search !== pathWithQuery || url.hash !== "") return fail("BAD_PATH", 0);
      const bytes = new TextEncoder().encode(body ?? "");
      const s = signApiRequest(deps.signer, method, pathWithQuery, bytes, deps.now());
      const headers: Record<string, string> = { [API_KEY_HEADER]: deps.apiKey, [API_TS_HEADER]: s.ts, [API_SIG_HEADER]: s.sig, accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await deps.fetch(url.href, {
          method,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
          ...(body !== undefined ? { body } : {}),
        });
      } catch {
        return fail("NETWORK", 0);
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      const after = retryAfterMs(res);
      if (res.status === 404) return fail("NOT_FOUND", 404, {}, after);
      if (res.ok && isObj(parsed) && parsed.ok === true) return { ok: true, status: res.status, data: parsed };
      if (!isObj(parsed)) return fail(res.ok ? "BAD_RESPONSE" : `HTTP_${res.status}`, res.status, {}, after);
      const code = typeof parsed.error === "string" && CODE_RE.test(parsed.error) ? parsed.error : res.ok ? "BAD_RESPONSE" : `HTTP_${res.status}`;
      return fail(code, res.status, scalarFields(parsed), after);
    },
  };
}

// ---- hints (package text, English) ----------------------------------------------------------------

export const LIVE_HINTS: Readonly<Record<string, string>> = {
  NOT_FOUND: LIVE_NOT_AVAILABLE,
  BAD_API_BASE: "DEGENLY_API_BASE must be an https:// origin (no path, no query). Unset it to use https://degenly.app.",
  BAD_DEGENLY_HOME: "DEGENLY_HOME must be an absolute path outside the current working directory. Unset it to use your home directory.",
  BAD_PATH: "Only /v1/ paths of the Degenly Bot API are sent.",
  BAD_OWNER: "Pass your main wallet address: setup --owner <Solana address>. It is the wallet you sign in with on degenly.app.",
  WALLET_EXISTS: "An agent wallet already exists and is never overwritten. For a new pairing code run: degenly pair --owner <main wallet address>",
  WALLET_CORRUPT: "~/.degenly/agent-wallet.json is not a valid wallet file. It was left as is. Restore it from your backup; do not delete it if it holds funds.",
  WALLET_WRITE_FAILED: "Could not write ~/.degenly/agent-wallet.json. Check disk space and permissions.",
  NO_WALLET: "No agent wallet on this computer. Run: degenly setup --owner <main wallet address>",
  NOT_LOGGED_IN: "No API key stored. After pairing on degenly.app/bot, run: degenly login (paste the key on stdin) or degenly login --key-file <path>",
  CREDENTIALS_CORRUPT: "~/.degenly/credentials.json is not readable. Run degenly login again.",
  CREDENTIALS_WRITE_FAILED: "Could not write ~/.degenly/credentials.json. Check disk space and permissions.",
  KEY_ARG_REFUSED: "The API key is never taken as a command argument (it would stay in shell history). Pipe it on stdin: degenly login < key.txt, or use: degenly login --key-file <path>",
  NO_KEY_INPUT: "No API key on stdin. Pipe it in (degenly login < key.txt) or use: degenly login --key-file <path>",
  KEY_FILE_UNREADABLE: "Could not read the --key-file path.",
  KEY_FORMAT: "That is not a Degenly API key (it starts with dgk_). Copy the key shown once on degenly.app/bot after pairing.",
  KEY_WALLET_MISMATCH: "This API key belongs to another wallet than the agent wallet on this computer. Pair this agent wallet on degenly.app/bot and log in with its key.",
  NETWORK: "Could not reach Degenly. Check the connection and retry.",
  BAD_RESPONSE: "Degenly answered something unexpected. Retry later.",
  SPEND_LIMIT: "Refused by the spending limit set on degenly.app/bot (per trade or per day). Only the wallet owner can change it there.",
  SPEND_LIMIT_NOT_SET: "This agent wallet has no spending limit row. Pair it again on degenly.app/bot.",
  TOKEN_BLOCKED: "Degenly does not allow buying this token through the API (see reason). Selling is never blocked.",
  API_BUDGET_EXHAUSTED: "The monthly API budget of all agents is used up. Retry after retryAfterMs.",
  API_SEATS_FULL: "All agent seats are taken. Retry later.",
  KEY_REQUIRED: "Degenly did not receive an API key. Run: degenly login",
  KEY_INVALID: "Degenly does not know this API key, or it was revoked. Pair again on degenly.app/bot and run degenly login.",
  SIGNATURE_REQUIRED: "Degenly did not receive a signature.",
  SIGNATURE_INVALID: "Degenly could not verify the request signature with this agent wallet.",
  TS_SKEW: "This computer's clock is more than 30 s off. Fix the system time and retry.",
  REPLAY: "This exact signed request was already used. Retry (a new signature is made each time).",
  API_TERMS_REQUIRED: "The API Terms changed. Pair again on degenly.app/bot to accept the current version.",
  RATE_LIMITED: "Wait retryAfterMs, then retry.",
  // DGAJ29: recovery phrase (hints never carry a word of it)
  RECOVERY_NEEDS_TERMINAL: "Run this yourself in your own terminal. It is never shown to an agent.",
  NO_RECOVERY_PHRASE: "This agent wallet was created before recovery phrases existed. Back up ~/.degenly/agent-wallet.json, or withdraw and run setup again.",
  RECOVERY_CORRUPT: "~/.degenly/recovery.json is not a valid recovery file. It was left as is. Your agent wallet file still works; back it up.",
  RECOVERY_MISMATCH: "~/.degenly/recovery.json does not belong to the agent wallet on this computer, so no words are shown. Both files were left as is. Back up ~/.degenly/agent-wallet.json.",
  RECOVERY_EXISTS: "~/.degenly/recovery.json already exists (it may be the only copy of a wallet's phrase) and is never overwritten. Move it somewhere safe first if you really want a new wallet.",
  PHRASE_ARG_REFUSED: "The recovery phrase is never taken as a command argument (it would stay in shell history). Pipe it on stdin: degenly recover < phrase.txt, or use: degenly recover --phrase-file <path>",
  NO_PHRASE_INPUT: "No recovery phrase on stdin. Pipe it in (degenly recover < phrase.txt) or use: degenly recover --phrase-file <path>. Delete that file afterwards.",
  PHRASE_FILE_UNREADABLE: "Could not read the --phrase-file path.",
  PHRASE_WORD_COUNT: "A Degenly agent wallet recovery phrase has exactly 12 words, separated by spaces.",
  PHRASE_UNKNOWN_WORD: "One of the words is not in the BIP39 English word list. Check the spelling against what you wrote down; nothing is guessed.",
  PHRASE_CHECKSUM: "The 12 words are valid words but not a valid recovery phrase (checksum). Check the order and spelling; nothing is guessed.",
  // DGAJ30: withdraw (funds can only go back to the paired main wallet)
  OWNER_UNKNOWN:
    "This computer has no record of your paired main wallet, so nothing can be withdrawn. Run: degenly pair --owner <main wallet address> (no new pairing is needed just to record it)",
  WITHDRAW_NOT_AVAILABLE: "Withdrawals are not switched on yet on this server.",
  WITHDRAW_NEEDS_TERMINAL:
    "degenly withdraw runs only in your own interactive terminal (no --json) and asks you to type YES. An agent uses the MCP tool degenly_live_withdraw instead, which shows you a confirmation form.",
  NOTHING_TO_WITHDRAW: "The agent wallet has no SOL left to withdraw after the network fee.",
  INSUFFICIENT_BALANCE: "The agent wallet does not hold that much SOL plus the network fee (see balanceLamports, feeLamports).",
  DESTINATION_NOT_ALLOWED: "A withdrawal never names a destination: funds can only go back to your paired main wallet.",
  OWNER_IS_AGENT: "The paired main wallet is the agent wallet itself. Pair again with your main wallet.",
  NOT_AN_AGENT_KEY: "This API key is not a paired agent key. Pair the agent on degenly.app/bot and run degenly login.",
  SIMULATION_FAILED: "The network simulation of the withdrawal failed. Nothing was signed or sent. Check the balance and retry later.",
};

export function liveHint(code: string): string {
  return LIVE_HINTS[code] ?? `Degenly answered ${code}. Retry later.`;
}
