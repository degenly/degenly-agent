#!/usr/bin/env node
/**
 * DGAJD1: `degenly` CLI + the shared command layer (`createOps`) the MCP server (./mcp.ts) also uses.
 *
 * Built for an agent in a terminal:
 *  - one command, never a prompt, never a browser;
 *  - `--json` → ONE line, stable field names; every answer has `mode: "demo"` and `note`;
 *  - error → non-zero exit + `{"ok":false,"error":"CODE","hint":"..."}`;
 *  - buy / sell / quote / token take a MINT ADDRESS only (no names: a copycat coin can share a name);
 *  - coin names / symbols come back as `{ "untrusted": "..." }`.
 *
 * DEMO: no wallet, no key, no signature, no real trade. The demo record lives in `~/.degenly/demo.json` and is
 * never sent anywhere. Network = Degenly's public read endpoints (./api.ts). Every demo answer: `mode: "demo"`.
 *
 * LIVE (DGAJ15, core only): `setup` / `pair` / `login` / `whoami`. The agent wallet is created on this computer
 * (./keys.ts), requests are signed (./sign.ts) and sent to `/v1/*` (./client.ts). Every live answer:
 * `mode: "live"`. No live trade command exists yet (DGAJ16). Demo and live never share a code path or a file.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { CREDENTIALS_PATH_TEXT, API_KEY_DISPLAY_CHARS, KEY_INPUT_MAX_BYTES, LIVE_NOT_AVAILABLE, createLiveClient, liveHint, loadCredentials, plausibleApiKey, resolveApiBase, saveCredentials } from "./client.js";
import { AGENT_WALLET_WARNING, WALLET_PATH_TEXT, createWallet, loadWallet, resolveHome } from "./keys.js";
import { API_PAIR_TS_SKEW_MS, createPairingCode, isSolanaAddress, type Signer } from "./sign.js";
import {
  QUOTE_DAILY_MAX,
  QUOTE_MIN_GAP_MS,
  TOP_WINDOWS,
  checkQuoteLimit,
  createClient,
  list,
  parseQuote,
  parseSearchHit,
  parseTokenRow,
  parseTopRow,
  recordQuote,
  type ApiResult,
  type FetchLike,
  type TokenInfo,
  type TopWindow,
} from "./api.js";
import { SOL_DECIMALS, SOL_MINT, demoFill, demoNetworkLamports, formatUnits, parseSol, parseUnits, type DemoQuote } from "./demo/fill.js";
import { DEMO_START_LAMPORTS, loadDemo, resetDemo, saveDemo, type DemoStateV1 } from "./demo/store.js";
import { SYMBOL_MAX_CHARS, cleanText, isMint, showUntrusted, untrustedName, untrustedSymbol, type UntrustedText } from "./sanitize.js";
import { createLiveRead } from "./tools/live-read.js";

export const VERSION = "0.1.1";
export const DEMO_NOTE = "Demo trade. No real funds moved.";
export const LIVE_NOTICE = "Demo mode: 10 demo SOL, live prices, record kept only on this computer (~/.degenly/demo.json). For live mode the human runs: degenly setup --owner <main wallet address>";
export const RECORD_PATH_TEXT = "~/.degenly/demo.json";
export const TRADES_DEFAULT = 20;
export const TRADES_MAX = 200;
export const TRENDING_DEFAULT = 10;
export const TRENDING_MAX = 50;
/** Same bounds as the site's search (`SEARCH_QUERY_MIN_LEN` / `SEARCH_QUERY_MAX_LEN`, degenly/src/edge/dataApi.ts). */
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 40;
const BPS_FULL = 10_000n;

export type Answer = {
  ok: boolean;
  mode: "demo" | "live";
  note: string;
  error?: string;
  hint?: string;
  retryAfterMs?: number;
  notice?: string;
  [k: string]: unknown;
};

// ---- errors ----------------------------------------------------------------------------------

const HINTS: Readonly<Record<string, string>> = {
  MINT_REQUIRED: "Pass the token's mint address (base58, 32-44 chars). Names and symbols are not accepted. Find mints with: search <text>.",
  BAD_AMOUNT: "SOL amount as a decimal string, e.g. 0.1 (more than 0, at most 9 decimals).",
  BAD_PERCENT: "Use all, or a percent above 0 and up to 100, e.g. 50 or 50%.",
  TOO_SMALL: "The amount rounds to 0 raw units. Use a larger amount.",
  BAD_ARGS: "Wrong arguments. Run: degenly help",
  UNKNOWN_COMMAND: "Unknown command. Run: degenly help",
  LOW_SOL: "Not enough demo SOL. Check: demo status. Start over with: demo reset (10 demo SOL).",
  NO_HOLD: "No demo position in this mint, or less than requested. Check: demo status.",
  STALE_QUOTE: "The price quote was older than 15 s when it was applied. Retry.",
  BAD_QUOTE: "Degenly sent a quote this package cannot use. Retry later.",
  RATE_LIMITED: `Wait retryAfterMs, then retry. Local cap: 1 quote per ${QUOTE_MIN_GAP_MS / 1000} s, ${QUOTE_DAILY_MAX} quotes per day.`,
  TOKEN_NOT_FOUND: "Degenly has no Solana token with this mint.",
  NO_ROUTE: "No route for this token and amount right now. Try a different amount later.",
  TOO_SMALL_UPSTREAM: "Amount too small to quote. Use a larger amount.",
  NETWORK: "Could not reach degenly.app. Check the connection and retry.",
  BAD_RESPONSE: "degenly.app answered something unexpected. Retry later.",
  SAVE_FAILED: `Could not write ${RECORD_PATH_TEXT}. Check disk space and permissions.`,
  NOT_AVAILABLE_IN_DEMO: "Live commands do not run here. Demo commands (demo ...) use demo SOL only: no real funds.",
};

/** 0 ok · 2 usage · 3 rate limited · 4 network / Degenly side · 1 any other refusal. */
export function exitCodeFor(error: string | undefined): number {
  if (error === undefined) return 0;
  if (["BAD_ARGS", "UNKNOWN_COMMAND", "MINT_REQUIRED", "BAD_AMOUNT", "BAD_PERCENT", "TOO_SMALL", "BAD_OWNER", "KEY_ARG_REFUSED", "NO_KEY_INPUT", "KEY_FORMAT", "BAD_API_BASE", "BAD_DEGENLY_HOME"].includes(error)) return 2;
  if (error === "RATE_LIMITED") return 3;
  if (["NETWORK", "BAD_RESPONSE", "UPSTREAM", "MISSING_KEY", "NOT_CONFIGURED", "CROSS_SITE"].includes(error) || error.startsWith("HTTP_")) return 4;
  return 1;
}

function okAnswer(fields: Record<string, unknown>): Answer {
  return { ok: true, mode: "demo", note: DEMO_NOTE, ...fields };
}

function fail(error: string, extra: Record<string, unknown> = {}): Answer {
  const hint = HINTS[error === "TOO_SMALL" && extra.upstream === true ? "TOO_SMALL_UPSTREAM" : error] ?? `Degenly answered ${error}. Retry later.`;
  const rest = { ...extra };
  delete rest.upstream;
  return { ok: false, mode: "demo", note: DEMO_NOTE, error, hint, ...rest };
}

function fromApi(r: Extract<ApiResult<unknown>, { ok: false }>): Answer {
  return fail(r.error, { ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}), ...(r.error === "TOO_SMALL" ? { upstream: true } : {}) });
}

// ---- small parsers ---------------------------------------------------------------------------

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?%?$/;

/** "all" → 10000; "50" / "50%" / "12.5%" → basis points of the position; anything else / 0 / > 100 → undefined. */
export function parsePercent(v: string): bigint | undefined {
  const s = v.trim().toLowerCase();
  if (s === "all" || s === "max") return BPS_FULL;
  const m = PERCENT.exec(s);
  if (!m) return undefined;
  const bps = BigInt(m[1] ?? "0") * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return bps > 0n && bps <= BPS_FULL ? bps : undefined;
}

function sol(lamports: bigint | string): string {
  return formatUnits(lamports, SOL_DECIMALS);
}

// ---- ops -------------------------------------------------------------------------------------

export interface OpsDeps {
  home: string;
  fetch: FetchLike;
  now: () => number;
}

export interface Ops {
  status(): Promise<Answer>;
  quote(mint: string, side: string, amount: string): Promise<Answer>;
  buy(mint: string, solAmount: string): Promise<Answer>;
  sell(mint: string, amount: string): Promise<Answer>;
  trades(limit?: number): Promise<Answer>;
  reset(): Promise<Answer>;
  token(mint: string): Promise<Answer>;
  search(query: string): Promise<Answer>;
  trending(window?: string, limit?: number): Promise<Answer>;
}

interface Loaded {
  state: DemoStateV1;
  extra: Record<string, unknown>;
}

export function createOps(deps: OpsDeps): Ops {
  const api = createClient(deps.fetch);
  // one operation at a time (an MCP client may send calls in parallel; the record is read-modify-write)
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => undefined);
    return run;
  };

  const load = (): Loaded => {
    const r = loadDemo(deps.home, deps.now());
    const extra: Record<string, unknown> = {};
    if (r.created) extra.notice = LIVE_NOTICE;
    if (r.recoveredFrom !== undefined) extra.recoveredFrom = r.recoveredFrom;
    return { state: r.state, extra };
  };

  const tokenInfo = async (mint: string): Promise<{ ok: true; token: TokenInfo } | { ok: false; answer: Answer }> => {
    const r = await api.tokens([mint]);
    if (!r.ok) return { ok: false, answer: fromApi(r) };
    const token = list(r.data, parseTokenRow).find((t) => t.mint === mint);
    return token ? { ok: true, token } : { ok: false, answer: fail("TOKEN_NOT_FOUND", { mint }) };
  };

  /** Decimals + display symbol of a mint: the demo position if held (no network), else `/api/data/tokens`. */
  const metaFor = async (s: DemoStateV1, mint: string): Promise<{ ok: true; decimals: number; symbol: string } | { ok: false; answer: Answer }> => {
    const p = s.positions[mint];
    if (p) return { ok: true, decimals: p.decimals, symbol: p.symbol };
    const t = await tokenInfo(mint);
    return t.ok ? { ok: true, decimals: t.token.decimals, symbol: cleanText(t.token.symbol, SYMBOL_MAX_CHARS) } : t;
  };

  /** One live price-only quote through the local limiter. */
  const liveQuote = async (mint: string, side: "buy" | "sell", amount: bigint, decimals: number): Promise<{ ok: true; q: DemoQuote; receivedAt: number } | { ok: false; answer: Answer }> => {
    const lim = checkQuoteLimit(deps.home, deps.now());
    if (!lim.ok) return { ok: false, answer: fail("RATE_LIMITED", { retryAfterMs: lim.retryAfterMs }) };
    recordQuote(deps.home, deps.now());
    const r = await api.quote({ mint, side, amount, decimals });
    const receivedAt = deps.now();
    if (!r.ok) return { ok: false, answer: fromApi(r) };
    const q = parseQuote(r.data);
    const expected = side === "buy" ? { i: SOL_MINT, o: mint } : { i: mint, o: SOL_MINT };
    if (!q || q.side !== side || q.inputMint !== expected.i || q.outputMint !== expected.o || q.inAmount !== amount.toString()) return { ok: false, answer: fail("BAD_QUOTE") };
    return { ok: true, q, receivedAt };
  };

  /** Raw token units to sell: "all" / percent of the position, or (quote only) a token amount. */
  const sellRaw = (s: DemoStateV1, mint: string, amount: string, decimals: number, allowTokenAmount: boolean): { ok: true; raw: bigint } | { ok: false; answer: Answer } => {
    const held = s.positions[mint] ? BigInt(s.positions[mint].raw) : 0n;
    const bps = parsePercent(amount);
    if (bps !== undefined && (amount.trim().endsWith("%") || ["all", "max"].includes(amount.trim().toLowerCase()) || !allowTokenAmount)) {
      if (held <= 0n) return { ok: false, answer: fail("NO_HOLD", { mint }) };
      const raw = (held * bps) / BPS_FULL;
      return raw > 0n ? { ok: true, raw } : { ok: false, answer: fail("TOO_SMALL") };
    }
    if (!allowTokenAmount) return { ok: false, answer: fail("BAD_PERCENT") };
    const raw = parseUnits(amount, decimals);
    return raw !== undefined ? { ok: true, raw } : { ok: false, answer: fail("BAD_AMOUNT", { hint: `Token amount as a decimal string (at most ${decimals} decimals), or all, or a percent like 50%.` }) };
  };

  const positionsOf = (s: DemoStateV1) =>
    Object.values(s.positions)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((p) => ({
        mint: p.mint,
        symbol: untrustedSymbol(p.symbol),
        amount: formatUnits(p.raw, p.decimals),
        raw: p.raw,
        decimals: p.decimals,
        costSol: sol(p.costLamports),
        openedAt: new Date(p.openedAt).toISOString(),
      }));

  const trade = async (mint: string, side: "buy" | "sell", amountArg: string): Promise<Answer> => {
    if (!isMint(mint)) return fail("MINT_REQUIRED");
    if (mint === SOL_MINT) return fail("BAD_ARGS", { hint: "SOL is the demo balance itself; pass a token mint." });
    let lamports: bigint | undefined;
    if (side === "buy") {
      lamports = parseSol(amountArg);
      if (lamports === undefined) return fail("BAD_AMOUNT");
    } else if (parsePercent(amountArg) === undefined) {
      return fail("BAD_PERCENT");
    }
    const { state, extra } = load();
    if (side === "buy" && lamports !== undefined && lamports > BigInt(state.balanceLamports)) {
      return fail("LOW_SOL", { balanceSol: sol(state.balanceLamports), ...extra });
    }
    let raw: bigint;
    let decimals: number;
    let symbol: string;
    if (side === "sell") {
      const p = state.positions[mint];
      if (!p) return fail("NO_HOLD", { mint, ...extra });
      const r = sellRaw(state, mint, amountArg, p.decimals, false);
      if (!r.ok) return { ...r.answer, ...extra };
      raw = r.raw;
      decimals = p.decimals;
      symbol = p.symbol;
    } else {
      const lim = checkQuoteLimit(deps.home, deps.now());
      if (!lim.ok) return fail("RATE_LIMITED", { retryAfterMs: lim.retryAfterMs, ...extra });
      const m = await metaFor(state, mint);
      if (!m.ok) return { ...m.answer, ...extra };
      raw = lamports ?? 0n;
      decimals = m.decimals;
      symbol = m.symbol;
    }
    const lq = await liveQuote(mint, side, raw, decimals);
    if (!lq.ok) return { ...lq.answer, ...extra };
    const now = deps.now();
    const r = demoFill(state, { ...lq.q, receivedAt: lq.receivedAt }, { symbol, decimals }, now);
    if (!r.ok) return fail(r.error, { mint, ...extra });
    if (!saveDemo(deps.home, r.state)) return fail("SAVE_FAILED", extra);
    const t = r.trade;
    const net = BigInt(t.networkLamports);
    const common = { side, mint, symbol: untrustedSymbol(t.symbol), tradeId: t.id, feeBps: t.feeBps, networkSol: sol(net), balanceSol: sol(r.state.balanceLamports) };
    if (side === "buy") {
      return okAnswer({ ...common, spentSol: sol(BigInt(t.inAmount) + net), received: formatUnits(t.outAmount, decimals), receivedRaw: t.outAmount, ...extra });
    }
    const left = r.state.positions[mint];
    const proceeds = BigInt(t.outAmount) - net;
    return okAnswer({
      ...common,
      sold: formatUnits(t.inAmount, decimals),
      soldRaw: t.inAmount,
      receivedSol: sol(proceeds > 0n ? proceeds : 0n),
      realizedSol: sol(t.realizedLamports ?? "0"),
      left: left ? formatUnits(left.raw, left.decimals) : "0",
      ...extra,
    });
  };

  return {
    status: () =>
      serial(async () => {
        const { state, extra } = load();
        return okAnswer({
          balanceSol: sol(state.balanceLamports),
          balanceLamports: state.balanceLamports,
          startSol: sol(DEMO_START_LAMPORTS),
          realizedSol: sol(state.realizedLamports),
          positions: positionsOf(state),
          tradeCount: state.trades.length,
          record: RECORD_PATH_TEXT,
          ...extra,
        });
      }),

    quote: (mint, side, amount) =>
      serial(async () => {
        if (!isMint(mint)) return fail("MINT_REQUIRED");
        if (mint === SOL_MINT) return fail("BAD_ARGS", { hint: "SOL is the demo balance itself; pass a token mint." });
        if (side !== "buy" && side !== "sell") return fail("BAD_ARGS", { hint: "Side must be buy or sell." });
        const { state, extra } = load();
        let raw: bigint;
        if (side === "buy") {
          const l = parseSol(amount);
          if (l === undefined) return fail("BAD_AMOUNT", extra);
          raw = l;
        }
        const lim = checkQuoteLimit(deps.home, deps.now());
        if (!lim.ok) return fail("RATE_LIMITED", { retryAfterMs: lim.retryAfterMs, ...extra });
        const m = await metaFor(state, mint);
        if (!m.ok) return { ...m.answer, ...extra };
        if (side === "sell") {
          const r = sellRaw(state, mint, amount, m.decimals, true);
          if (!r.ok) return { ...r.answer, ...extra };
          raw = r.raw;
        } else {
          raw = parseSol(amount) ?? 0n;
        }
        const lq = await liveQuote(mint, side, raw, m.decimals);
        if (!lq.ok) return { ...lq.answer, ...extra };
        const q = lq.q;
        const net = demoNetworkLamports(q);
        return okAnswer({
          quoteOnly: true,
          side,
          mint,
          symbol: untrustedSymbol(m.symbol),
          in: side === "buy" ? sol(q.inAmount) : formatUnits(q.inAmount, m.decimals),
          out: side === "buy" ? formatUnits(q.outAmount, m.decimals) : sol(q.outAmount),
          inRaw: q.inAmount,
          outRaw: q.outAmount,
          feeBps: q.cost.degenlyFeeBps,
          networkSol: sol(net),
          ...(q.priceImpactPct !== undefined ? { priceImpactPct: q.priceImpactPct } : {}),
          validForMs: 15_000,
          ...extra,
        });
      }),

    buy: (mint, solAmount) => serial(() => trade(mint, "buy", solAmount)),
    sell: (mint, amount) => serial(() => trade(mint, "sell", amount)),

    trades: (limit = TRADES_DEFAULT) =>
      serial(async () => {
        if (!Number.isInteger(limit) || limit < 1 || limit > TRADES_MAX) return fail("BAD_ARGS", { hint: `limit must be 1-${TRADES_MAX}.` });
        const { state, extra } = load();
        const dec = new Map<string, number>();
        for (const t of state.trades) if (t.side === "buy") dec.set(t.mint, t.outDecimals);
        for (const p of Object.values(state.positions)) dec.set(p.mint, p.decimals);
        const rows = state.trades.slice(0, limit).map((t) => {
          const d = dec.get(t.mint);
          const net = BigInt(t.networkLamports);
          const tokenRaw = t.side === "buy" ? t.outAmount : t.inAmount;
          const solMoved = t.side === "buy" ? BigInt(t.inAmount) + net : BigInt(t.outAmount) - net;
          return {
            id: t.id,
            at: new Date(t.at).toISOString(),
            side: t.side,
            mint: t.mint,
            symbol: untrustedSymbol(t.symbol),
            tokenAmount: d !== undefined ? formatUnits(tokenRaw, d) : undefined,
            tokenRaw,
            sol: sol(solMoved > 0n ? solMoved : 0n),
            feeBps: t.feeBps,
            ...(t.realizedLamports !== undefined ? { realizedSol: sol(t.realizedLamports) } : {}),
          };
        });
        return okAnswer({ count: rows.length, total: state.trades.length, trades: rows, ...extra });
      }),

    reset: () =>
      serial(async () => {
        const { state, extra } = load();
        const next = resetDemo(state, deps.now());
        if (!saveDemo(deps.home, next)) return fail("SAVE_FAILED", extra);
        return okAnswer({ balanceSol: sol(next.balanceLamports), positions: [], ...extra });
      }),

    token: (mint) =>
      serial(async () => {
        if (!isMint(mint)) return fail("MINT_REQUIRED");
        const t = await tokenInfo(mint);
        if (!t.ok) return t.answer;
        const k = t.token;
        const warnings: string[] = [];
        if (k.freezeAuthorityDisabled === false) warnings.push("Freeze authority is enabled: this token can be frozen and may not be sellable.");
        if (k.mintAuthorityDisabled === false) warnings.push("Mint authority is enabled: more of this token can be created.");
        return okAnswer({
          mint: k.mint,
          name: untrustedName(k.name),
          symbol: untrustedSymbol(k.symbol),
          decimals: k.decimals,
          usdPrice: k.usdPrice,
          mcapUsd: k.mcapUsd,
          liquidityUsd: k.liquidityUsd,
          volume24hUsd: k.volume24hUsd,
          priceChange24hPct: k.priceChange24hPct,
          holderCount: k.holderCount,
          mintAuthorityDisabled: k.mintAuthorityDisabled,
          freezeAuthorityDisabled: k.freezeAuthorityDisabled,
          warnings,
        });
      }),

    search: (query) =>
      serial(async () => {
        const q = query.trim();
        if (q.length < SEARCH_MIN_CHARS || q.length > SEARCH_MAX_CHARS) return fail("BAD_ARGS", { hint: `Search text must be ${SEARCH_MIN_CHARS}-${SEARCH_MAX_CHARS} characters.` });
        const r = await api.search(q);
        if (!r.ok) return fromApi(r);
        const results = list(r.data, parseSearchHit).map((h) => ({
          mint: h.mint,
          name: untrustedName(h.name),
          symbol: untrustedSymbol(h.symbol),
          mcapUsd: h.mcapUsd,
          isVerified: h.isVerified,
          isSus: h.isSus,
          launchpad: h.launchpad !== undefined ? cleanText(h.launchpad, 24) : undefined,
        }));
        return okAnswer({ query: q, count: results.length, results, caution: "Many tokens share names. Pick by mint and check it with: token <mint>." });
      }),

    trending: (window = "1h", limit = TRENDING_DEFAULT) =>
      serial(async () => {
        if (!(TOP_WINDOWS as readonly string[]).includes(window)) return fail("BAD_ARGS", { hint: `window must be one of ${TOP_WINDOWS.join(", ")}.` });
        if (!Number.isInteger(limit) || limit < 1 || limit > TRENDING_MAX) return fail("BAD_ARGS", { hint: `limit must be 1-${TRENDING_MAX}.` });
        const r = await api.top(window as TopWindow);
        if (!r.ok) return fromApi(r);
        const tokens = list(r.data, parseTopRow)
          .slice(0, limit)
          .map((t) => ({
            mint: t.mint,
            name: untrustedName(t.name),
            symbol: untrustedSymbol(t.symbol),
            decimals: t.decimals,
            usdPrice: t.usdPrice,
            mcapUsd: t.mcapUsd,
            volume24hUsd: t.volume24hUsd,
            priceChange24hPct: t.priceChange24hPct,
          }));
        return okAnswer({ window, count: tokens.length, tokens });
      }),
  };
}

// ---- CLI -------------------------------------------------------------------------------------

export const USAGE = [
  "degenly - Degenly for AI agents (demo mode: 10 demo SOL, live prices, no wallet, no real funds)",
  "",
  "  degenly demo status                       demo balance + positions",
  "  degenly demo quote <mint> buy <sol>       live price only, nothing traded",
  "  degenly demo quote <mint> sell <amount|N%|all>",
  "  degenly demo buy <mint> <sol>             demo buy at the live price",
  "  degenly demo sell <mint> <N%|all>         demo sell at the live price",
  "  degenly demo trades [--limit N]           demo trade history (newest first)",
  "  degenly demo reset                        back to 10 demo SOL",
  "  degenly token <mint>                      name, decimals, price, audit",
  "  degenly search <text>                     find mints by name / symbol",
  "  degenly trending [5m|1h|6h|24h] [--limit N]",
  "  degenly mcp                               MCP stdio server (also: no arguments)",
  "",
  "Agent wallet (kept on this computer, ~/.degenly/agent-wallet.json):",
  "  degenly setup --owner <main wallet>       create the agent wallet + print a pairing code",
  "  degenly pair --owner <main wallet>        new pairing code for the existing agent wallet",
  "  degenly login [--key-file <path>]         store the API key from stdin or a file (never an argument)",
  "  degenly whoami                            check the API key + agent wallet with Degenly",
  "  degenly live holdings                     real balances of the agent wallet",
  "  degenly live ledger [--limit N]           confirmed Degenly trades of the agent wallet",
  "  degenly live quote <mint> buy <sol>       real quote, nothing signed or sent",
  "  degenly live quote <mint> sell <N%|all>",
  "",
  "Add --json for one-line JSON. Mint addresses only; coin names are untrusted text.",
  "Live buy / sell: MCP tools degenly_live_buy / degenly_live_sell only (the human confirms each trade).",
].join("\n");

interface Parsed {
  json: boolean;
  limit?: number;
  owner?: string;
  keyFile?: string;
  /** a `--key` / `--api-key` style flag was given: refused, its value is never used or echoed */
  keyArg: boolean;
  rest: string[];
  bad?: string;
}

/** Value of a flag that takes one; the next word only if it is not itself a flag. */
function flagValue(argv: string[], i: number): string | undefined {
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { json: false, keyArg: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--json") out.json = true;
    else if (a === "--limit") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v)) out.bad = "--limit needs a whole number.";
      else out.limit = v;
    } else if (a.startsWith("--limit=")) {
      const v = Number(a.slice("--limit=".length));
      if (!Number.isInteger(v)) out.bad = "--limit needs a whole number.";
      else out.limit = v;
    } else if (a === "--owner" || a === "--key-file") {
      const v = flagValue(argv, i);
      if (v !== undefined) i++;
      if (a === "--owner") out.owner = v ?? "";
      else out.keyFile = v ?? "";
    } else if (a.startsWith("--owner=")) out.owner = a.slice("--owner=".length);
    else if (a.startsWith("--key-file=")) out.keyFile = a.slice("--key-file=".length);
    else if (/^--(api-?)?key(=|$)/.test(a)) {
      out.keyArg = true;
      if (!a.includes("=") && flagValue(argv, i) !== undefined) i++;
    } else out.rest.push(a);
  }
  return out;
}

function humanValue(v: unknown): string {
  if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as UntrustedText).untrusted === "string" && Object.keys(v).length === 1) {
    return showUntrusted(v as UntrustedText);
  }
  if (typeof v === "object" && v !== null) {
    return Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${k}=${humanValue(x)}`)
      .join(" ");
  }
  return String(v);
}

/** Short human output: no JSON, one fact per line. */
export function humanize(title: string, a: Answer): string {
  const head = a.ok ? `${a.mode === "live" ? "LIVE" : "DEMO"} ${title}: ok (${a.note})` : `${a.mode === "live" ? "LIVE" : "DEMO"} ${title}: ${a.error ?? "ERROR"} - ${a.hint ?? ""}`;
  const lines = [head];
  for (const [k, v] of Object.entries(a)) {
    if (["ok", "mode", "note", "error", "hint"].includes(k) || v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: ${v.length === 0 ? "none" : ""}`);
      for (const item of v) lines.push(`  - ${humanValue(item)}`);
    } else lines.push(`${k}: ${humanValue(v)}`);
  }
  return lines.join("\n");
}

const args = (n: number, r: string[]): boolean => r.length === n;

// ---- live (DGAJ15 core: no trade command yet) --------------------------------------------------

export const LIVE_NOTE = "Live mode. The agent wallet key stays on this computer and is never sent.";
export const PAIR_NEXT_STEP =
  'Next: open https://degenly.app/bot, sign in with your main wallet, choose "Pair agent" and paste the pairing code. Then run login with the API key the site shows once. Fund the agent wallet with SOL only with what you can afford to lose.';
/** Max wait for piped stdin at `login` (never a prompt: a terminal stdin is not read at all). */
export const STDIN_WAIT_MS = 5_000;

export interface LiveDeps {
  /** home the live files live under (`~`, or DEGENLY_HOME); undefined + homeError when DEGENLY_HOME is refused */
  home: string;
  homeError?: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: FetchLike;
  now: () => number;
  /** whole piped stdin ("" for a terminal / nothing piped) */
  readStdin: () => Promise<string>;
}

function liveOk(fields: Record<string, unknown>): Answer {
  return { ok: true, mode: "live", note: LIVE_NOTE, ...fields };
}

function liveFail(error: string, extra: Record<string, unknown> = {}): Answer {
  return { ok: false, mode: "live", note: LIVE_NOTE, error, hint: liveHint(error), ...extra };
}

function pairingAnswer(wallet: Signer, owner: string, now: number, created: boolean): Answer {
  const { code } = createPairingCode(wallet, owner, now);
  return liveOk({
    created,
    address: wallet.address,
    ownerWallet: owner,
    pairingCode: code,
    pairingCodeValidMs: API_PAIR_TS_SKEW_MS,
    walletFile: WALLET_PATH_TEXT,
    warning: AGENT_WALLET_WARNING,
    next: PAIR_NEXT_STEP,
  });
}

function ownerError(owner: string | undefined, agent?: string): Answer | undefined {
  if (owner === undefined || !isSolanaAddress(owner) || owner === agent) return liveFail("BAD_OWNER");
  return undefined;
}

async function liveSetup(d: LiveDeps, owner: string | undefined): Promise<Answer> {
  if (d.homeError) return liveFail(d.homeError);
  const bad = ownerError(owner);
  if (bad || owner === undefined) return bad ?? liveFail("BAD_OWNER");
  const c = createWallet(d.home);
  if (!c.ok) {
    if (c.error !== "WALLET_EXISTS") return liveFail(c.error);
    const l = loadWallet(d.home);
    return liveFail("WALLET_EXISTS", l.ok ? { address: l.wallet.address } : {});
  }
  return pairingAnswer(c.wallet, owner, d.now(), true);
}

async function livePair(d: LiveDeps, owner: string | undefined): Promise<Answer> {
  if (d.homeError) return liveFail(d.homeError);
  const l = loadWallet(d.home);
  if (!l.ok) return liveFail(l.error);
  const bad = ownerError(owner, l.wallet.address);
  if (bad || owner === undefined) return bad ?? liveFail("BAD_OWNER");
  return pairingAnswer(l.wallet, owner, d.now(), false);
}

async function liveLogin(d: LiveDeps, p: Parsed): Promise<Answer> {
  // the key is never taken from argv (shell history): any extra word or a --key flag is refused, stdin unread
  if (p.keyArg || p.rest.length !== 1) return liveFail("KEY_ARG_REFUSED");
  if (d.homeError) return liveFail(d.homeError);
  const l = loadWallet(d.home);
  if (!l.ok) return liveFail(l.error);
  let input: string;
  if (p.keyFile !== undefined) {
    try {
      const buf = readFileSync(p.keyFile);
      if (buf.length > KEY_INPUT_MAX_BYTES) return liveFail("KEY_FORMAT");
      input = buf.toString("utf8");
    } catch {
      return liveFail("KEY_FILE_UNREADABLE");
    }
  } else {
    input = await d.readStdin();
  }
  const key = input.trim();
  if (key === "") return liveFail("NO_KEY_INPUT");
  if (!plausibleApiKey(key)) return liveFail("KEY_FORMAT");
  if (!saveCredentials(d.home, key)) return liveFail("CREDENTIALS_WRITE_FAILED");
  return liveOk({ address: l.wallet.address, keyPrefix: key.slice(0, API_KEY_DISPLAY_CHARS), credentialsFile: CREDENTIALS_PATH_TEXT, next: "Check it with: degenly whoami" });
}

async function liveWhoami(d: LiveDeps): Promise<Answer> {
  if (d.homeError) return liveFail(d.homeError);
  const l = loadWallet(d.home);
  if (!l.ok) return liveFail(l.error);
  const c = loadCredentials(d.home);
  if (!c.ok) return liveFail(c.error, { address: l.wallet.address });
  const b = resolveApiBase(d.env);
  if (!b.ok) return liveFail(b.error);
  const client = createLiveClient({ fetch: d.fetch, base: b.base, apiKey: c.apiKey, signer: l.wallet, now: d.now });
  const r = await client.request("GET", "/v1/whoami");
  if (!r.ok) {
    const extra: Record<string, unknown> = { ...r.fields, status: r.status, ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}) };
    return liveFail(r.error, r.error === "NOT_FOUND" ? { ...extra, hint: LIVE_NOT_AVAILABLE } : extra);
  }
  const wallet = typeof r.data.wallet === "string" ? r.data.wallet : "";
  if (wallet !== l.wallet.address) return liveFail("KEY_WALLET_MISMATCH", { address: l.wallet.address });
  return liveOk({
    wallet,
    keyId: typeof r.data.keyId === "string" ? cleanText(r.data.keyId, 64) : undefined,
    serverTs: typeof r.data.serverTs === "number" ? r.data.serverTs : undefined,
    apiBase: b.base,
  });
}

/**
 * Runs one CLI command (never prompts). `out` = the full text to print; `code` = the exit code.
 * `live` absent (demo-only callers) → the live commands keep answering NOT_AVAILABLE_IN_DEMO.
 */
export async function runCli(argv: string[], ops: Ops, live?: LiveDeps): Promise<{ code: number; out: string }> {
  const p = parseArgs(argv);
  const r = p.rest;
  const done = (title: string, a: Answer) => ({ code: a.ok ? 0 : exitCodeFor(a.error), out: p.json ? JSON.stringify(a) : humanize(title, a) });
  if (p.bad !== undefined) return done("error", fail("BAD_ARGS", { hint: p.bad }));
  const [c0, c1, c2, c3, c4] = r;

  if (c0 === "help" || c0 === "--help" || c0 === "-h") return { code: 0, out: p.json ? JSON.stringify(okAnswer({ usage: USAGE })) : USAGE };
  if (c0 === "version" || c0 === "--version") return { code: 0, out: p.json ? JSON.stringify(okAnswer({ version: VERSION })) : VERSION };
  if (p.keyArg) return done("login", liveFail("KEY_ARG_REFUSED"));
  if (live && (c0 === "setup" || c0 === "pair")) {
    if (!args(1, r)) return done(c0, liveFail("BAD_ARGS", { hint: `Usage: degenly ${c0} --owner <main wallet address>` }));
    return done(c0, c0 === "setup" ? await liveSetup(live, p.owner) : await livePair(live, p.owner));
  }
  if (live && c0 === "login") return done("login", await liveLogin(live, p));
  if (live && c0 === "whoami") return done("whoami", args(1, r) ? await liveWhoami(live) : liveFail("BAD_ARGS", { hint: "Usage: degenly whoami" }));
  // DGAJ16: live READ commands only (a live buy / sell needs the human confirmation form: MCP only)
  if (live && c0 === "live") {
    const read = createLiveRead(live);
    if (c1 === "holdings" && args(2, r)) return done("live holdings", await read.holdings());
    if (c1 === "ledger" && args(2, r)) return done("live ledger", await read.ledger(p.limit));
    if (c1 === "quote" && args(5, r)) return done("live quote", await read.quote(c2 ?? "", c3 ?? "", c4 ?? ""));
    return done("live", liveFail("BAD_ARGS", { hint: "Usage: degenly live holdings | live ledger [--limit N] | live quote <mint> buy <sol> | live quote <mint> sell <N%|all>" }));
  }
  if (c0 === "setup" || c0 === "login" || c0 === "live" || c0 === "pair" || c0 === "whoami") return done(c0, fail("NOT_AVAILABLE_IN_DEMO"));

  if (c0 === "demo") {
    if (c1 === "status" && args(2, r)) return done("status", await ops.status());
    if (c1 === "quote" && args(5, r)) return done("quote", await ops.quote(c2 ?? "", c3 ?? "", c4 ?? ""));
    if (c1 === "buy" && args(4, r)) return done("buy", await ops.buy(c2 ?? "", c3 ?? ""));
    if (c1 === "sell" && args(4, r)) return done("sell", await ops.sell(c2 ?? "", c3 ?? ""));
    if (c1 === "trades" && args(2, r)) return done("trades", await ops.trades(p.limit));
    if (c1 === "reset" && args(2, r)) return done("reset", await ops.reset());
    return done("demo", fail(c1 && ["status", "quote", "buy", "sell", "trades", "reset"].includes(c1) ? "BAD_ARGS" : "UNKNOWN_COMMAND"));
  }
  if (c0 === "token" && args(2, r)) return done("token", await ops.token(c1 ?? ""));
  if (c0 === "search" && r.length >= 2) return done("search", await ops.search(r.slice(1).join(" ")));
  if (c0 === "trending" && r.length <= 2) return done("trending", await ops.trending(c1 ?? "1h", p.limit));
  if (c0 === "token" || c0 === "search" || c0 === "trending") return done(c0, fail("BAD_ARGS"));
  return done("error", fail("UNKNOWN_COMMAND"));
}

export function defaultOps(): Ops {
  return createOps({ home: homedir(), fetch: (url, init) => fetch(url, init), now: () => Date.now() });
}

/** Whole piped stdin, capped; a terminal is never read (no prompt), a silent pipe ends after STDIN_WAIT_MS. */
async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise<string>((resolveText) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      resolveText(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    process.stdin.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      // larger than any key: keep a marker over the cap so the format check refuses it
      chunks.push(size > KEY_INPUT_MAX_BYTES ? Buffer.from("x".repeat(KEY_INPUT_MAX_BYTES + 1)) : b);
      if (size > KEY_INPUT_MAX_BYTES) finish();
    });
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
  });
}

export function defaultLive(): LiveDeps {
  const h = resolveHome(process.env, homedir(), process.cwd());
  return {
    home: h.ok ? h.home : "",
    ...(h.ok ? {} : { homeError: h.error }),
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    readStdin: readPipedStdin,
  };
}

async function main(argv: string[]): Promise<void> {
  const ops = defaultOps();
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "mcp")) {
    const { startMcpStdio } = await import("./mcp.js");
    await startMcpStdio(ops, defaultLive());
    return;
  }
  const r = await runCli(argv, ops, defaultLive());
  process.stdout.write(`${r.out}\n`);
  process.exitCode = r.code;
}

function isEntry(): boolean {
  const a = process.argv[1];
  if (a === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(a)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).catch(() => {
    process.stdout.write(`${JSON.stringify(fail("INTERNAL", { hint: "Unexpected failure. Retry; if it repeats, run: degenly demo reset" }))}\n`);
    process.exitCode = 1;
  });
}
