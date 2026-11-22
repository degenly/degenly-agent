/**
 * DGAJD1: the ONLY network code of the package — Degenly's public READ endpoints, measured headerless (22.11):
 *
 *   GET /api/swap/quote?mint&side&amount&decimals   price-only quote (no `taker` → no transaction, no pending order)
 *   GET /api/data/tokens?mints=a,b                  name / symbol / decimals / price / audit
 *   GET /api/data/prices?mints=a,b                  USD price
 *   GET /api/data/search?q=<text>                   name / symbol search (≤ 10 hits)
 *   GET /api/data/top?w=5m|1h|6h|24h                most traded (short-key wire rows)
 *
 * No cookie, no key, no wallet, no custom header, no telemetry: nothing about the user's demo leaves the machine.
 * Every quote costs Degenly an upstream call, so a LOCAL limiter (below) caps quotes per machine; the server keeps
 * its own per-IP limit on top.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoQuote } from "./demo/fill.js";
import { demoDir } from "./demo/store.js";
import { cleanText } from "./sanitize.js";

export const BASE_URL = "https://degenly.app";
export const REQUEST_TIMEOUT_MS = 20_000;
/** Local quote limiter: at most 1 quote per QUOTE_MIN_GAP_MS … */
export const QUOTE_MIN_GAP_MS = 2_000;
/** … and at most QUOTE_DAILY_MAX quotes per UTC day, per machine. */
export const QUOTE_DAILY_MAX = 300;
export const QUOTA_FILE_NAME = "quote-limit.json";
export const TOP_WINDOWS = ["5m", "1h", "6h", "24h"] as const;
export type TopWindow = (typeof TOP_WINDOWS)[number];

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number; retryAfterMs?: number };

// ---- local quote limiter -----------------------------------------------------------------------

interface QuotaRecord {
  day: string; // UTC YYYY-MM-DD
  count: number;
  lastAt: number;
}

export type LimitCheck = { ok: true } | { ok: false; error: "RATE_LIMITED"; retryAfterMs: number };

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function readQuota(home: string): QuotaRecord | undefined {
  const file = join(demoDir(home), QUOTA_FILE_NAME);
  if (!existsSync(file)) return undefined;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof v !== "object" || v === null) return undefined;
    const r = v as Record<string, unknown>;
    if (typeof r.day !== "string" || typeof r.count !== "number" || typeof r.lastAt !== "number") return undefined;
    return { day: r.day, count: r.count, lastAt: r.lastAt };
  } catch {
    return undefined;
  }
}

export function checkQuoteLimit(home: string, now: number): LimitCheck {
  const q = readQuota(home);
  if (!q) return { ok: true };
  const gap = q.lastAt + QUOTE_MIN_GAP_MS - now;
  if (gap > 0) return { ok: false, error: "RATE_LIMITED", retryAfterMs: gap };
  if (q.day === utcDay(now) && q.count >= QUOTE_DAILY_MAX) return { ok: false, error: "RATE_LIMITED", retryAfterMs: nextUtcMidnight(now) - now };
  return { ok: true };
}

export function recordQuote(home: string, now: number): void {
  const q = readQuota(home);
  const day = utcDay(now);
  const next: QuotaRecord = { day, count: q && q.day === day ? q.count + 1 : 1, lastAt: now };
  try {
    mkdirSync(demoDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(join(demoDir(home), QUOTA_FILE_NAME), JSON.stringify(next), { mode: 0o600 });
  } catch {
    // disk refused: the server's own per-IP limit still applies
  }
}

// ---- HTTP --------------------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function retryAfterMs(r: Response): number | undefined {
  const h = r.headers.get("retry-after");
  if (h === null) return undefined;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : undefined;
}

async function getJson(fetch: FetchLike, path: string, params: Record<string, string>): Promise<ApiResult<Record<string, unknown>>> {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: "NETWORK", status: 0 };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 429) {
    const after = retryAfterMs(res);
    return { ok: false, error: "RATE_LIMITED", status: 429, ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }
  if (!isObj(body)) return { ok: false, error: "BAD_RESPONSE", status: res.status };
  if (!res.ok || body.ok !== true) {
    const code = typeof body.error === "string" ? cleanText(body.error, 40) : `HTTP_${res.status}`;
    return { ok: false, error: code || `HTTP_${res.status}`, status: res.status };
  }
  return { ok: true, data: body };
}

export interface QuoteRequest {
  mint: string;
  side: "buy" | "sell";
  /** raw units: lamports for a buy, token raw units for a sell */
  amount: bigint;
  /** the token's decimals */
  decimals: number;
}

export interface Client {
  quote(r: QuoteRequest): Promise<ApiResult<unknown>>;
  tokens(mints: string[]): Promise<ApiResult<unknown>>;
  prices(mints: string[]): Promise<ApiResult<unknown>>;
  search(q: string): Promise<ApiResult<unknown>>;
  top(w: TopWindow): Promise<ApiResult<unknown>>;
}

export function createClient(fetch: FetchLike): Client {
  const field = async (path: string, params: Record<string, string>, key: string): Promise<ApiResult<unknown>> => {
    const r = await getJson(fetch, path, params);
    return r.ok ? { ok: true, data: r.data[key] } : r;
  };
  return {
    quote: (r) => field("/api/swap/quote", { mint: r.mint, side: r.side, amount: r.amount.toString(), decimals: String(r.decimals) }, "quote"),
    tokens: (mints) => field("/api/data/tokens", { mints: mints.join(",") }, "data"),
    prices: (mints) => field("/api/data/prices", { mints: mints.join(",") }, "data"),
    search: (q) => field("/api/data/search", { q }, "data"),
    top: (w) => field("/api/data/top", { w }, "data"),
  };
}

// ---- answer mapping (only the fields the package uses; everything else is dropped) ------------------

const UINT = /^\d+$/;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The quote fields the demo fill reads. A transaction in the answer (never expected without a taker) is ignored. */
export function parseQuote(v: unknown): DemoQuote | undefined {
  if (!isObj(v) || !isObj(v.cost)) return undefined;
  const side = v.side;
  if (side !== "buy" && side !== "sell") return undefined;
  const inputMint = str(v.inputMint);
  const outputMint = str(v.outputMint);
  const inAmount = str(v.inAmount);
  const outAmount = str(v.outAmount);
  const inDecimals = num(v.inDecimals);
  const outDecimals = num(v.outDecimals);
  const feeBps = num(v.cost.degenlyFeeBps);
  const feeUsd = num(v.cost.degenlyFeeUsd);
  const network = num(v.cost.networkAndPriorityLamports);
  if (!inputMint || !outputMint || inAmount === undefined || outAmount === undefined || !UINT.test(inAmount) || !UINT.test(outAmount)) return undefined;
  if (inDecimals === undefined || outDecimals === undefined || feeBps === undefined || feeUsd === undefined || network === undefined) return undefined;
  return {
    side,
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    inDecimals,
    outDecimals,
    cost: { degenlyFeeBps: feeBps, degenlyFeeUsd: feeUsd, networkAndPriorityLamports: network, rentLamports: num(v.cost.rentLamports) },
    priceImpactPct: num(v.cost.priceImpactPct),
  };
}

/** One token as the package reports it. `name` / `symbol` are raw network text: wrap with `untrusted*` before output. */
export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  usdPrice?: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  priceChange24hPct?: number;
  holderCount?: number;
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  isVerified?: boolean;
  isSus?: true;
}

function setNum<K extends keyof TokenInfo>(t: TokenInfo, k: K, v: unknown): void {
  const n = num(v);
  if (n !== undefined) (t as unknown as Record<string, unknown>)[k] = n;
}

/** `/api/data/tokens` row (long keys). */
export function parseTokenRow(v: unknown): TokenInfo | undefined {
  if (!isObj(v)) return undefined;
  const mint = str(v.mint);
  const decimals = num(v.decimals);
  if (!mint || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return undefined;
  const t: TokenInfo = { mint, name: str(v.name) ?? "", symbol: str(v.symbol) ?? "", decimals };
  const icon = str(v.icon);
  if (icon !== undefined) t.icon = icon;
  setNum(t, "usdPrice", v.usdPrice);
  setNum(t, "mcapUsd", v.mcapUsd);
  setNum(t, "liquidityUsd", v.liquidityUsd);
  setNum(t, "volume24hUsd", v.volume24hUsd);
  setNum(t, "priceChange24hPct", v.priceChange24hPct);
  setNum(t, "holderCount", v.holderCount);
  if (isObj(v.audit)) {
    if (typeof v.audit.mintAuthorityDisabled === "boolean") t.mintAuthorityDisabled = v.audit.mintAuthorityDisabled;
    if (typeof v.audit.freezeAuthorityDisabled === "boolean") t.freezeAuthorityDisabled = v.audit.freezeAuthorityDisabled;
  }
  return t;
}

/** `/api/data/search` hit (no decimals in the hit). */
export interface SearchHit {
  mint: string;
  name: string;
  symbol: string;
  mcapUsd?: number;
  launchpad?: string;
  isVerified?: boolean;
  isSus?: true;
}

export function parseSearchHit(v: unknown): SearchHit | undefined {
  if (!isObj(v)) return undefined;
  const mint = str(v.mint);
  if (!mint) return undefined;
  const h: SearchHit = { mint, name: str(v.name) ?? "", symbol: str(v.symbol) ?? "" };
  const mc = num(v.mcapUsd);
  if (mc !== undefined) h.mcapUsd = mc;
  const lp = str(v.launchpad);
  if (lp !== undefined) h.launchpad = lp;
  if (typeof v.isVerified === "boolean") h.isVerified = v.isVerified;
  if (v.isSus === true) h.isSus = true;
  return h;
}

/** `/api/data/top` wire row (short keys, degenly/src/data/topWire.ts SCALAR_KEYS). */
export function parseTopRow(v: unknown): TokenInfo | undefined {
  if (!isObj(v)) return undefined;
  const mint = str(v.m);
  const decimals = num(v.d);
  if (!mint || decimals === undefined) return undefined;
  const t: TokenInfo = { mint, name: str(v.n) ?? "", symbol: str(v.s) ?? "", decimals };
  setNum(t, "usdPrice", v.p);
  setNum(t, "mcapUsd", v.mc);
  setNum(t, "liquidityUsd", v.lq);
  setNum(t, "volume24hUsd", v.v24);
  setNum(t, "priceChange24hPct", v.c24);
  setNum(t, "holderCount", v.h);
  return t;
}

export function list<T>(v: unknown, map: (x: unknown) => T | undefined): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const m = map(x);
    if (m !== undefined) out.push(m);
  }
  return out;
}
