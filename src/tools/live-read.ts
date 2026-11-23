/**
 * DGAJ16: live READ tools (MCP `degenly_live_*` + CLI `live holdings | ledger | quote`). Every answer: `mode: "live"`.
 *
 * Server contract (degenly repo, read only; src/edge/botApi.ts + swapApi.ts + portfolioApi.ts):
 *   GET /v1/whoami                         → {ok, wallet, keyId, bucket, serverTs}                       (botApi.ts:640-641)
 *   GET /v1/data/tokens?mints=<mint>       → {ok, data: [JupToken], untrustedFields}                     (botApi.ts:936-942)
 *   GET /v1/data/prices?mints=<mint>       → {ok, data: [{mint, usdPrice, …}], untrustedFields}          (dataApi.ts:577-582)
 *   GET /v1/data/holdings                  → {ok, data: {sol, tokens: [{mint, raw, decimals}]}, …}      (botApi.ts:928-934)
 *   GET /v1/data/ledger                    → {ok, wallet, rows: [{signature, side, inputMint, …}]}       (portfolioApi.ts:180-187)
 *   GET /v1/quote?mint&side&amount&decimals → {ok, quote: SwapQuote (requestId, transaction base64, …)} (swapApi.ts:455-616)
 * Coin names / symbols are untrusted text (./sanitize.ts): cleaned + `{ "untrusted": "…" }`. Mint addresses only.
 * A quote answer's transaction bytes never leave this module as output (./live-trade.ts signs its own quote only).
 */
import type { Answer, LiveDeps } from "../cli.js";
import { LIVE_NOTE } from "../cli.js";
import { createLiveClient, liveHint, loadCredentials, resolveApiBase, type LiveClient, type LiveResult } from "../client.js";
import { parseTokenRow, list, type TokenInfo } from "../api.js";
import { SOL_DECIMALS, SOL_MINT, formatUnits, parseSol } from "../demo/fill.js";
import { loadWallet } from "../keys.js";
import { cleanText, isMint, untrustedName, untrustedSymbol } from "../sanitize.js";
import { isSolanaAddress, type Signer } from "../sign.js";

/** A token mint argument: base58, 32-44 chars (./sanitize.ts) AND 32 bytes; never a name / symbol. */
export function isLiveMint(v: string): boolean {
  return isMint(v) && isSolanaAddress(v);
}

/** Must equal `API_PRIORITY_MAX_LAMPORTS` (degenly/src/config/apiConstants.ts:144): what the server adds to each buy. */
export const API_PRIORITY_MAX_LAMPORTS = 5_000_000n;
export const LEDGER_MAX = 100;
const BPS_FULL = 10_000n;

const LOCAL_HINTS: Readonly<Record<string, string>> = {
  MINT_REQUIRED: "Pass the token's mint address (base58, 32-44 chars). Names and symbols are not accepted.",
  BAD_AMOUNT: "SOL amount as a decimal string, e.g. 0.1 (more than 0, at most 9 decimals).",
  BAD_PERCENT: "Use all, or a percent above 0 and up to 100, e.g. 50%.",
  BAD_ARGS: "Wrong arguments for this tool.",
  TOO_SMALL: "The amount rounds to 0 raw units. Use a larger amount.",
  TOKEN_NOT_FOUND: "Degenly has no Solana token with this mint.",
  NO_HOLD: "The agent wallet holds none of this token (or less than requested). Check: degenly_live_holdings.",
  BAD_QUOTE: "Degenly sent a quote this package cannot use. Nothing was signed or sent.",
  LIVE_NOT_READY: "Live tools need an agent wallet and an API key on this computer. Run: degenly setup --owner <main wallet>, pair on degenly.app/bot, then degenly login.",
};

export function liveAnswer(fields: Record<string, unknown>): Answer {
  return { ok: true, mode: "live", note: LIVE_NOTE, ...fields };
}

export function liveError(error: string, extra: Record<string, unknown> = {}): Answer {
  return { ok: false, mode: "live", note: LIVE_NOTE, error, hint: LOCAL_HINTS[error] ?? liveHint(error), ...extra };
}

/** A server refusal as is: its stable code + its scalar fields (scope, limitLamports, reason, …) + HTTP status. */
export function fromServer(r: Extract<LiveResult, { ok: false }>): Answer {
  return liveError(r.error, { ...r.fields, status: r.status, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) });
}

// ---- readiness ---------------------------------------------------------------------------------

export interface LiveCtx {
  wallet: Signer;
  client: LiveClient;
  base: string;
  now: () => number;
}

export type LiveOpen = { ok: true; ctx: LiveCtx } | { ok: false; error: string; missing: string[]; address?: string };

/** Wallet + API key + API base, all local. No network. */
export function openLive(d: LiveDeps): LiveOpen {
  if (d.homeError) return { ok: false, error: d.homeError, missing: ["a valid DEGENLY_HOME (or unset it)"] };
  const missing: string[] = [];
  const w = loadWallet(d.home);
  if (!w.ok) missing.push(w.error === "NO_WALLET" ? "agent wallet: run degenly setup --owner <main wallet address>" : "agent wallet file is not valid (~/.degenly/agent-wallet.json)");
  const c = loadCredentials(d.home);
  if (!c.ok) missing.push(c.error === "NOT_LOGGED_IN" ? "API key: pair on degenly.app/bot, then run degenly login" : "API key file is not valid: run degenly login again");
  const b = resolveApiBase(d.env);
  if (!b.ok) missing.push("DEGENLY_API_BASE must be an https:// origin");
  if (!w.ok || !c.ok || !b.ok) {
    const error = !w.ok ? w.error : !c.ok ? c.error : "BAD_API_BASE";
    return { ok: false, error, missing, ...(w.ok ? { address: w.wallet.address } : {}) };
  }
  return { ok: true, ctx: { wallet: w.wallet, base: b.base, now: d.now, client: createLiveClient({ fetch: d.fetch, base: b.base, apiKey: c.apiKey, signer: w.wallet, now: d.now }) } };
}

export function liveReady(d: LiveDeps): boolean {
  return openLive(d).ok;
}

function notReady(o: Extract<LiveOpen, { ok: false }>): Answer {
  return liveError(o.error, { missing: o.missing, ...(o.address !== undefined ? { address: o.address } : {}) });
}

// ---- shared reads ------------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const UINT = /^\d+$/;
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export async function fetchToken(ctx: LiveCtx, mint: string): Promise<{ ok: true; token: TokenInfo } | { ok: false; answer: Answer }> {
  const r = await ctx.client.request("GET", `/v1/data/tokens?${new URLSearchParams({ mints: mint }).toString()}`);
  if (!r.ok) return { ok: false, answer: fromServer(r) };
  const token = list(r.data.data, parseTokenRow).find((t) => t.mint === mint);
  return token ? { ok: true, token } : { ok: false, answer: liveError("TOKEN_NOT_FOUND", { mint }) };
}

export interface LiveHolding {
  mint: string;
  raw: bigint;
  decimals: number;
}

export async function fetchHoldings(ctx: LiveCtx): Promise<{ ok: true; solLamports: bigint; tokens: LiveHolding[]; fetchedAt?: number } | { ok: false; answer: Answer }> {
  const r = await ctx.client.request("GET", "/v1/data/holdings");
  if (!r.ok) return { ok: false, answer: fromServer(r) };
  const d = r.data.data;
  if (!isObj(d) || typeof d.sol !== "string" || !UINT.test(d.sol) || !Array.isArray(d.tokens)) return { ok: false, answer: liveError("BAD_RESPONSE") };
  const tokens: LiveHolding[] = [];
  for (const t of d.tokens) {
    if (!isObj(t) || !isMint(t.mint) || typeof t.raw !== "string" || !UINT.test(t.raw) || typeof t.decimals !== "number" || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) continue;
    tokens.push({ mint: t.mint, raw: BigInt(t.raw), decimals: t.decimals });
  }
  const fetchedAt = num(r.data.fetchedAt);
  return { ok: true, solLamports: BigInt(d.sol), tokens, ...(fetchedAt !== undefined ? { fetchedAt } : {}) };
}

/** "all" → 10000; "50" / "50%" / "12.5%" → basis points; anything else → undefined. */
export function percentBps(v: string): bigint | undefined {
  const s = v.trim().toLowerCase();
  if (s === "all" || s === "max") return BPS_FULL;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?%?$/.exec(s);
  if (!m) return undefined;
  const bps = BigInt(m[1] ?? "0") * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return bps > 0n && bps <= BPS_FULL ? bps : undefined;
}

/** What a sell of `amount` (all / N%) of the agent wallet's holding is, in raw token units. */
export async function sellRaw(ctx: LiveCtx, mint: string, amount: string): Promise<{ ok: true; raw: bigint; decimals: number } | { ok: false; answer: Answer }> {
  const bps = percentBps(amount);
  if (bps === undefined) return { ok: false, answer: liveError("BAD_PERCENT") };
  const h = await fetchHoldings(ctx);
  if (!h.ok) return h;
  const held = h.tokens.find((t) => t.mint === mint);
  if (!held || held.raw <= 0n) return { ok: false, answer: liveError("NO_HOLD", { mint }) };
  const raw = (held.raw * bps) / BPS_FULL;
  return raw > 0n ? { ok: true, raw, decimals: held.decimals } : { ok: false, answer: liveError("TOO_SMALL") };
}

export interface LiveQuote {
  requestId: string;
  side: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  inDecimals: number;
  outDecimals: number;
  feeBps: number;
  networkLamports: number;
  slippagePct?: number;
  priceImpactPct?: number;
  expiresInMs: number;
  tradingEnabled: boolean;
  /** base64; kept inside the package (never part of an answer) */
  transaction?: string;
}

function parseLiveQuote(v: unknown): LiveQuote | undefined {
  if (!isObj(v) || !isObj(v.cost)) return undefined;
  const side = v.side;
  if (side !== "buy" && side !== "sell") return undefined;
  const requestId = str(v.requestId);
  const inputMint = str(v.inputMint);
  const outputMint = str(v.outputMint);
  const inAmount = str(v.inAmount);
  const outAmount = str(v.outAmount);
  const minOutAmount = str(v.minOutAmount);
  const inDecimals = num(v.inDecimals);
  const outDecimals = num(v.outDecimals);
  const feeBps = num(v.cost.degenlyFeeBps);
  const networkLamports = num(v.cost.networkAndPriorityLamports);
  const expiresInMs = num(v.expiresInMs);
  if (!requestId || !inputMint || !outputMint || !inAmount || !outAmount || !minOutAmount) return undefined;
  if (![inAmount, outAmount, minOutAmount].every((x) => UINT.test(x))) return undefined;
  if (inDecimals === undefined || outDecimals === undefined || feeBps === undefined || networkLamports === undefined || expiresInMs === undefined) return undefined;
  const slippagePct = num(v.slippageAppliedPct);
  const priceImpactPct = num(v.cost.priceImpactPct);
  const transaction = str(v.transaction);
  return {
    requestId: cleanText(requestId, 64),
    side,
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    minOutAmount,
    inDecimals,
    outDecimals,
    feeBps,
    networkLamports,
    expiresInMs,
    tradingEnabled: v.tradingEnabled === true,
    ...(slippagePct !== undefined ? { slippagePct } : {}),
    ...(priceImpactPct !== undefined ? { priceImpactPct } : {}),
    ...(transaction !== undefined && transaction !== "" ? { transaction } : {}),
  };
}

/** One `/v1/quote` for the agent wallet, checked against what was asked (side, mints, amount). */
export async function fetchQuote(ctx: LiveCtx, mint: string, side: "buy" | "sell", amountRaw: bigint, decimals: number): Promise<{ ok: true; q: LiveQuote; receivedAt: number } | { ok: false; answer: Answer }> {
  const params = new URLSearchParams({ mint, side, amount: amountRaw.toString(), decimals: String(decimals) });
  const r = await ctx.client.request("GET", `/v1/quote?${params.toString()}`);
  const receivedAt = ctx.now();
  if (!r.ok) return { ok: false, answer: fromServer(r) };
  const q = parseLiveQuote(r.data.quote);
  const want = side === "buy" ? { i: SOL_MINT, o: mint } : { i: mint, o: SOL_MINT };
  if (!q || q.side !== side || q.inputMint !== want.i || q.outputMint !== want.o || q.inAmount !== amountRaw.toString()) return { ok: false, answer: liveError("BAD_QUOTE") };
  return { ok: true, q, receivedAt };
}

/** The facts of a quote an agent / human reads (no transaction bytes). */
export function quoteFacts(q: LiveQuote, mint: string, decimals: number): Record<string, unknown> {
  const buy = q.side === "buy";
  return {
    side: q.side,
    mint,
    in: buy ? formatUnits(q.inAmount, SOL_DECIMALS) : formatUnits(q.inAmount, decimals),
    out: buy ? formatUnits(q.outAmount, decimals) : formatUnits(q.outAmount, SOL_DECIMALS),
    minOut: buy ? formatUnits(q.minOutAmount, decimals) : formatUnits(q.minOutAmount, SOL_DECIMALS),
    inRaw: q.inAmount,
    outRaw: q.outAmount,
    feeBps: q.feeBps,
    networkSol: formatUnits(BigInt(Math.max(0, Math.floor(q.networkLamports))), SOL_DECIMALS),
    ...(q.slippagePct !== undefined ? { slippagePct: q.slippagePct } : {}),
    ...(q.priceImpactPct !== undefined ? { priceImpactPct: q.priceImpactPct } : {}),
    validForMs: q.expiresInMs,
  };
}

// ---- tools -------------------------------------------------------------------------------------

export interface LiveRead {
  whoami(): Promise<Answer>;
  token(mint: string): Promise<Answer>;
  price(mint: string): Promise<Answer>;
  holdings(): Promise<Answer>;
  ledger(limit?: number): Promise<Answer>;
  quote(mint: string, side: string, amount: string): Promise<Answer>;
}

/** `limits` of a whoami answer when the server sends them (decimal lamport strings); undefined otherwise. */
export function whoamiLimits(data: Record<string, unknown>): { perTradeLamports: bigint; dailyLamports: bigint; usedLamports?: bigint } | undefined {
  const l = data.limits;
  if (!isObj(l)) return undefined;
  const per = str(l.perTradeLamports);
  const day = str(l.dailyLamports);
  if (per === undefined || day === undefined || !UINT.test(per) || !UINT.test(day)) return undefined;
  const used = str(l.usedLamports);
  return { perTradeLamports: BigInt(per), dailyLamports: BigInt(day), ...(used !== undefined && UINT.test(used) ? { usedLamports: BigInt(used) } : {}) };
}

export function confirmMode(env: Readonly<Record<string, string | undefined>>): "on" | "off" {
  return (env.DEGENLY_CONFIRM ?? "").trim().toLowerCase() === "off" ? "off" : "on";
}

export function createLiveRead(d: LiveDeps): LiveRead {
  const withCtx = async (f: (ctx: LiveCtx) => Promise<Answer>): Promise<Answer> => {
    const o = openLive(d);
    if (!o.ok) return notReady(o);
    return f(o.ctx);
  };
  return {
    whoami: () =>
      withCtx(async (ctx) => {
        const r = await ctx.client.request("GET", "/v1/whoami");
        if (!r.ok) return fromServer(r);
        const wallet = typeof r.data.wallet === "string" ? r.data.wallet : "";
        if (wallet !== ctx.wallet.address) return liveError("KEY_WALLET_MISMATCH", { address: ctx.wallet.address });
        const lim = whoamiLimits(r.data);
        return liveAnswer({
          wallet,
          keyId: typeof r.data.keyId === "string" ? cleanText(r.data.keyId, 64) : undefined,
          serverTs: num(r.data.serverTs),
          apiBase: ctx.base,
          confirm: confirmMode(d.env),
          limits: lim ? { perTradeSol: formatUnits(lim.perTradeLamports, SOL_DECIMALS), dailySol: formatUnits(lim.dailyLamports, SOL_DECIMALS) } : "unknown",
        });
      }),

    token: (mint) =>
      withCtx(async (ctx) => {
        if (!isLiveMint(mint)) return liveError("MINT_REQUIRED");
        const t = await fetchToken(ctx, mint);
        if (!t.ok) return t.answer;
        const k = t.token;
        const warnings: string[] = [];
        if (k.freezeAuthorityDisabled === false) warnings.push("Freeze authority is enabled: this token can be frozen and may not be sellable.");
        if (k.mintAuthorityDisabled === false) warnings.push("Mint authority is enabled: more of this token can be created.");
        return liveAnswer({
          mint: k.mint,
          name: untrustedName(k.name),
          symbol: untrustedSymbol(k.symbol),
          decimals: k.decimals,
          usdPrice: k.usdPrice,
          mcapUsd: k.mcapUsd,
          liquidityUsd: k.liquidityUsd,
          mintAuthorityDisabled: k.mintAuthorityDisabled,
          freezeAuthorityDisabled: k.freezeAuthorityDisabled,
          warnings,
        });
      }),

    price: (mint) =>
      withCtx(async (ctx) => {
        if (!isLiveMint(mint)) return liveError("MINT_REQUIRED");
        const r = await ctx.client.request("GET", `/v1/data/prices?${new URLSearchParams({ mints: mint }).toString()}`);
        if (!r.ok) return fromServer(r);
        const row = Array.isArray(r.data.data) ? r.data.data.find((x): x is Record<string, unknown> => isObj(x) && x.mint === mint) : undefined;
        const usdPrice = row ? num(row.usdPrice) : undefined;
        if (usdPrice === undefined) return liveError("TOKEN_NOT_FOUND", { mint });
        return liveAnswer({ mint, usdPrice });
      }),

    holdings: () =>
      withCtx(async (ctx) => {
        const h = await fetchHoldings(ctx);
        if (!h.ok) return h.answer;
        return liveAnswer({
          wallet: ctx.wallet.address,
          sol: formatUnits(h.solLamports, SOL_DECIMALS),
          solLamports: h.solLamports.toString(),
          tokens: h.tokens.map((t) => ({ mint: t.mint, amount: formatUnits(t.raw, t.decimals), raw: t.raw.toString(), decimals: t.decimals })),
          ...(h.fetchedAt !== undefined ? { fetchedAt: h.fetchedAt } : {}),
        });
      }),

    ledger: (limit = 20) =>
      withCtx(async (ctx) => {
        if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX) return liveError("BAD_ARGS", { hint: `limit must be 1-${LEDGER_MAX}.` });
        const r = await ctx.client.request("GET", "/v1/data/ledger");
        if (!r.ok) return fromServer(r);
        const rows = (Array.isArray(r.data.rows) ? r.data.rows : []).filter(isObj).slice(0, limit).map((x) => ({
          signature: typeof x.signature === "string" ? cleanText(x.signature, 100) : undefined,
          side: x.side === "buy" || x.side === "sell" ? x.side : undefined,
          inputMint: isMint(x.inputMint) ? x.inputMint : undefined,
          outputMint: isMint(x.outputMint) ? x.outputMint : undefined,
          volumeUsd: num(x.volumeUsd),
          feeBps: num(x.feeBps),
          at: num(x.createdAt) !== undefined ? new Date(num(x.createdAt) ?? 0).toISOString() : undefined,
        }));
        return liveAnswer({ wallet: ctx.wallet.address, count: rows.length, rows });
      }),

    quote: (mint, side, amount) =>
      withCtx(async (ctx) => {
        if (!isLiveMint(mint) || mint === SOL_MINT) return liveError("MINT_REQUIRED");
        if (side !== "buy" && side !== "sell") return liveError("BAD_ARGS", { hint: "Side must be buy or sell." });
        let raw: bigint;
        let decimals: number;
        let name: string;
        let symbol: string;
        const t = await fetchToken(ctx, mint);
        if (!t.ok) return t.answer;
        name = t.token.name;
        symbol = t.token.symbol;
        if (side === "buy") {
          const l = parseSol(amount);
          if (l === undefined) return liveError("BAD_AMOUNT");
          raw = l;
          decimals = t.token.decimals;
        } else {
          const s = await sellRaw(ctx, mint, amount);
          if (!s.ok) return s.answer;
          raw = s.raw;
          decimals = s.decimals;
        }
        const lq = await fetchQuote(ctx, mint, side, raw, decimals);
        if (!lq.ok) return lq.answer;
        return liveAnswer({ quoteOnly: true, name: untrustedName(name), symbol: untrustedSymbol(symbol), ...quoteFacts(lq.q, mint, decimals), tradingEnabled: lq.q.tradingEnabled });
      }),
  };
}
