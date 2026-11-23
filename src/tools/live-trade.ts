/**
 * DGAJ16: live BUY / SELL (MCP `degenly_live_buy` / `degenly_live_sell` only; no CLI command). Every answer: `mode: "live"`.
 *
 * One call = one fixed path, in this order (nothing is skipped by an argument):
 *   1. mint address only (MINT_REQUIRED), amount shape (BAD_AMOUNT / BAD_PERCENT)      — no network
 *   2. agent wallet + API key on this computer
 *   3. BUY: LOCAL spending limit (second layer; the server's is the real one, botApi.ts:683-699). The limit comes from
 *      the server's whoami answer; no limit in it → LOCAL_LIMIT_UNKNOWN (fail closed, nothing quoted or sent).
 *      SELL: never limited (the server never limits sells either, botApi.ts:51).
 *   4. `/v1/quote` for the agent wallet → the transaction to sign comes ONLY from this answer (no tool argument
 *      carries transaction bytes; there is no "sign this" tool). The agent wallet must be one of its signers
 *      (TX_NOT_FOR_WALLET) and (DGAJ22) the bytes must pass the local check ../tx.ts `checkAgentTx` (program
 *      allow-list + no value out of the agent wallet to a foreign account), checked before the human is asked.
 *   5. the human confirms (./confirm.ts). Not accepted → nothing is signed, `/v1/execute` is never called.
 *      DEGENLY_CONFIRM=off with a non-default DEGENLY_API_BASE → CUSTOM_API_NEEDS_CONFIRM (DGAJ22).
 *   6. sign the agent's slot (../tx.ts) → ONE `POST /v1/execute`. NO automatic retry: a network error / timeout
 *      answers EXECUTE_OUTCOME_UNKNOWN (the trade may have landed; a second send could buy twice).
 * Server refusals (SPEND_LIMIT, SPEND_LIMIT_NOT_SET, TOKEN_BLOCKED, TRADING_DISABLED, …) come back with the server's
 * code and fields as is (./live-read.ts `fromServer`).
 */
import type { Answer, LiveDeps } from "../cli.js";
import { SOL_DECIMALS, SOL_MINT, formatUnits, parseSol } from "../demo/fill.js";
import { untrustedName, untrustedSymbol } from "../sanitize.js";
import { base64ToBytes, bytesToBase64, checkAgentTx, signTransactionFor } from "../tx.js";
import { CONFIRM_OFF_HINT, requestConfirmation, type Elicitor } from "./confirm.js";
import {
  API_PRIORITY_MAX_LAMPORTS,
  fetchQuote,
  fetchToken,
  fromServer,
  isLiveMint,
  liveAnswer,
  liveError,
  openLive,
  quoteFacts,
  sellRaw,
  whoamiLimits,
  type LiveCtx,
} from "./live-read.js";

export const TRADE_HINTS: Readonly<Record<string, string>> = {
  LOCAL_LIMIT_UNKNOWN: "Degenly did not send this agent wallet's spending limit, so the package refuses the buy (fail closed). Nothing was quoted or sent.",
  LOCAL_SPEND_LIMIT: "Above the spending limit set on degenly.app/bot (checked on this computer before anything was sent). Only the wallet owner can change it there.",
  TX_NOT_FOR_WALLET: "The quoted transaction is not for this agent wallet. Nothing was signed or sent.",
  TX_INVALID: "The quoted transaction could not be read with certainty. Nothing was signed or sent.",
  TX_PROGRAM_NOT_ALLOWED: "The quoted transaction calls a program that is not on the swap allow-list (the same list degenly.app checks). Nothing was signed or sent.",
  TX_UNEXPECTED_TRANSFER: "The quoted transaction would move funds from the agent wallet to an address the agent wallet does not own. Nothing was signed or sent.",
  TX_INSTRUCTION_NOT_ALLOWED: "The quoted transaction asks the agent wallet for an instruction a swap never needs. Nothing was signed or sent.",
  CANCELLED: "The trade was not confirmed (declined, closed or timed out). Nothing was signed or sent.",
  CONFIRM_UNSUPPORTED: CONFIRM_OFF_HINT,
  EXECUTE_OUTCOME_UNKNOWN:
    "The trade was sent but no answer came back. It may have gone through. Do NOT retry: check degenly_live_holdings and degenly_live_ledger first.",
  TRADE_FAILED: "Degenly / Jupiter did not complete the trade (see failReason). Get a new quote before trying again.",
  TRADING_DISABLED: "Live trading is switched off on Degenly right now. Nothing was signed or sent.",
};

function tradeError(error: string, extra: Record<string, unknown> = {}): Answer {
  const a = liveError(error, extra);
  return TRADE_HINTS[error] !== undefined && extra.hint === undefined ? { ...a, hint: TRADE_HINTS[error] } : a;
}

/** DGAJ22: DEGENLY_CONFIRM=off is not honoured for a non-default DEGENLY_API_BASE. */
function customApiOffHint(base: string): string {
  return `DEGENLY_API_BASE points to ${base}, not degenly.app, and DEGENLY_CONFIRM=off is set. Trades to another server always need the confirmation form, so nothing was signed or sent. Remove DEGENLY_API_BASE unless you set it yourself on purpose.`;
}

export interface LiveTrade {
  buy(mint: string, sol: string): Promise<Answer>;
  sell(mint: string, amount: string): Promise<Answer>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const UINT = /^\d+$/;

/** Local limit check of one buy. undefined = allowed. */
async function localLimit(ctx: LiveCtx, lamports: bigint): Promise<Answer | undefined> {
  const r = await ctx.client.request("GET", "/v1/whoami");
  if (!r.ok) return fromServer(r);
  if (r.data.wallet !== ctx.wallet.address) return liveError("KEY_WALLET_MISMATCH", { address: ctx.wallet.address });
  const lim = whoamiLimits(r.data);
  if (!lim) return tradeError("LOCAL_LIMIT_UNKNOWN");
  const cost = lamports + API_PRIORITY_MAX_LAMPORTS;
  if (cost > lim.perTradeLamports) return tradeError("LOCAL_SPEND_LIMIT", { scope: "trade", limitSol: formatUnits(lim.perTradeLamports, SOL_DECIMALS) });
  const used = lim.usedLamports ?? 0n;
  if (used + cost > lim.dailyLamports) return tradeError("LOCAL_SPEND_LIMIT", { scope: "day", limitSol: formatUnits(lim.dailyLamports, SOL_DECIMALS), usedSol: formatUnits(used, SOL_DECIMALS) });
  return undefined;
}

export function createLiveTrade(d: LiveDeps, elicitor: () => Elicitor | undefined): LiveTrade {
  // one live trade at a time (an MCP client may send calls in parallel)
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => undefined);
    return run;
  };

  const trade = async (mint: string, side: "buy" | "sell", amountArg: string): Promise<Answer> => {
    // 1. inputs (no network): a mint address only (base58, 32-44 chars, decodes to 32 bytes)
    if (!isLiveMint(mint) || mint === SOL_MINT) return liveError("MINT_REQUIRED");
    let lamports: bigint | undefined;
    if (side === "buy") {
      lamports = parseSol(amountArg);
      if (lamports === undefined) return liveError("BAD_AMOUNT");
    } else if (!/^(all|max|\d{1,3}(\.\d{1,2})?%?)$/i.test(amountArg.trim())) {
      return liveError("BAD_PERCENT");
    }
    // 2. local files
    const o = openLive(d);
    if (!o.ok) return liveError(o.error, { missing: o.missing });
    const ctx = o.ctx;
    // 3. local limit (buy)
    if (side === "buy" && lamports !== undefined) {
      const refused = await localLimit(ctx, lamports);
      if (refused) return refused;
    }
    // 4. token facts + the quote this call signs
    const t = await fetchToken(ctx, mint);
    if (!t.ok) return t.answer;
    let raw: bigint;
    let decimals = t.token.decimals;
    if (side === "buy") raw = lamports ?? 0n;
    else {
      const s = await sellRaw(ctx, mint, amountArg);
      if (!s.ok) return s.answer;
      raw = s.raw;
      decimals = s.decimals;
    }
    const lq = await fetchQuote(ctx, mint, side, raw, decimals);
    if (!lq.ok) return lq.answer;
    const q = lq.q;
    const facts = quoteFacts(q, mint, decimals);
    const named = { name: untrustedName(t.token.name), symbol: untrustedSymbol(t.token.symbol) };
    if (!q.tradingEnabled) return tradeError("TRADING_DISABLED", { ...named, ...facts });
    const bytes = q.transaction !== undefined ? base64ToBytes(q.transaction) : undefined;
    if (!bytes) return liveError("BAD_QUOTE");
    // DGAJ22: the package's own check of the quoted bytes (allow-list + transfer rule), before the human is asked;
    // signTransactionFor runs it again right before signing.
    const checked = checkAgentTx(bytes, ctx.wallet.address);
    if (!checked.ok) return tradeError(checked.error);
    // 5. the human confirms (the summary names a non-default server on its first line)
    const outcome = await requestConfirmation(
      elicitor(),
      {
        side,
        mint,
        name: t.token.name,
        symbol: t.token.symbol,
        inText: String(facts.in),
        outText: String(facts.out),
        minOutText: String(facts.minOut),
        feeBps: q.feeBps,
        networkSol: String(facts.networkSol),
        ...(q.slippagePct !== undefined ? { slippagePct: q.slippagePct } : {}),
        ...(q.priceImpactPct !== undefined ? { priceImpactPct: q.priceImpactPct } : {}),
        apiBase: ctx.base,
      },
      d.env,
    );
    if (outcome === "custom_api_off") return tradeError("CUSTOM_API_NEEDS_CONFIRM", { apiBase: ctx.base, hint: customApiOffHint(ctx.base) });
    if (outcome === "unsupported") return tradeError("CONFIRM_UNSUPPORTED", { ...named, ...facts });
    if (outcome === "declined") return tradeError("CANCELLED", { ...named, ...facts });
    // 6. sign + ONE execute (no retry)
    const signed = signTransactionFor(bytes, ctx.wallet);
    if (!signed.ok) return tradeError(signed.error);
    const r = await ctx.client.request("POST", "/v1/execute", JSON.stringify({ signedTransaction: bytesToBase64(signed.signed), requestId: q.requestId }));
    if (!r.ok) {
      if (r.error === "NETWORK") return tradeError("EXECUTE_OUTCOME_UNKNOWN", { ...named, mint, side });
      // a 5xx after the send (e.g. 500 INTERNAL, 503 UPSTREAM_UNAVAILABLE): the outcome is unknown too, never retried
      if (r.status >= 500) return tradeError("EXECUTE_OUTCOME_UNKNOWN", { ...named, mint, side, serverError: r.error, status: r.status });
      return fromServer(r);
    }
    const res = isObj(r.data.result) ? r.data.result : {};
    const signature = str(res.signature);
    const status = res.status;
    const inRaw = str(res.totalInputAmount) ?? str(res.inputAmountResult);
    const outRaw = str(res.totalOutputAmount) ?? str(res.outputAmountResult);
    const amounts = {
      ...(inRaw !== undefined && UINT.test(inRaw) ? { spent: side === "buy" ? formatUnits(inRaw, SOL_DECIMALS) : formatUnits(inRaw, decimals), spentRaw: inRaw } : {}),
      ...(outRaw !== undefined && UINT.test(outRaw) ? { received: side === "buy" ? formatUnits(outRaw, decimals) : formatUnits(outRaw, SOL_DECIMALS), receivedRaw: outRaw } : {}),
    };
    if (status === "confirmed" && signature !== undefined) {
      return liveAnswer({ side, mint, ...named, status: "confirmed", txSignature: signature, ...amounts, confirm: outcome === "skipped_off" ? "off" : "human" });
    }
    return tradeError("TRADE_FAILED", {
      side,
      mint,
      ...named,
      failReason: str(res.failReason) ?? "unknown",
      failCode: str(res.failCode),
      ...(signature !== undefined ? { txSignature: signature } : {}),
    });
  };

  return {
    buy: (mint, sol) => serial(() => trade(mint, "buy", sol)),
    sell: (mint, amount) => serial(() => trade(mint, "sell", amount)),
  };
}
