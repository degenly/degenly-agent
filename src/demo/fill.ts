/**
 * DGAJD1: one demo fill — the SAME pure bigint function as the site's `demoFill`
 * (degenly/src/demo/fill.ts, DGDEMO1 spec §4.2), over the local record and a live price-only quote
 * (`/api/swap/quote` without a taker). Nothing here talks to the network or a wallet.
 *
 *  - The Degenly fee is already inside `outAmount` → it is NOT taken again; `feeUsd` / `feeBps` are kept for display.
 *  - Network = `networkAndPriorityLamports − rentLamports` (rent comes back on a full sell), at least 0.
 *  - No slippage model: the fill is the quote's `outAmount`; `minOutAmount` is not used.
 *  - Amounts are decimal strings; math is bigint. No float touches a balance.
 */
import { DEMO_TRADES_MAX, type DemoPosition, type DemoStateV1, type DemoTrade } from "./store.js";

/** Same value as the site (`QUOTE_MAX_AGE_MS`, degenly/src/config/constants.ts). */
export const QUOTE_MAX_AGE_MS = 15_000;
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;

/** The fields of the site's `SwapQuote` the fill reads (everything else of the answer is ignored). */
export interface DemoQuote {
  side: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  inDecimals: number;
  outDecimals: number;
  cost: {
    degenlyFeeBps: number;
    degenlyFeeUsd: number;
    networkAndPriorityLamports: number;
    rentLamports?: number | undefined;
  };
  priceImpactPct?: number | undefined;
}

export interface DemoTokenMeta {
  symbol: string;
  decimals: number;
  iconUrl?: string;
}
export type DemoFillError = "STALE_QUOTE" | "BAD_QUOTE" | "LOW_SOL" | "NO_HOLD";
export type DemoFillResult = { ok: true; state: DemoStateV1; trade: DemoTrade } | { ok: false; error: DemoFillError };

const UINT = /^\d+$/;

function big(v: string): bigint | undefined {
  return UINT.test(v) ? BigInt(v) : undefined;
}

function lamportsOf(v: number | undefined): bigint {
  return v !== undefined && Number.isFinite(v) && v > 0 ? BigInt(Math.floor(v)) : 0n;
}

function max0(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

/** Charged network part of a quote (signature + priority, rent excluded), lamports ≥ 0. */
export function demoNetworkLamports(q: Pick<DemoQuote, "cost">): bigint {
  return max0(lamportsOf(q.cost.networkAndPriorityLamports) - lamportsOf(q.cost.rentLamports));
}

export function demoFill(s: DemoStateV1, q: DemoQuote & { receivedAt: number }, meta: DemoTokenMeta, now: number): DemoFillResult {
  if (now - q.receivedAt > QUOTE_MAX_AGE_MS) return { ok: false, error: "STALE_QUOTE" };
  const side = q.side;
  if (side !== "buy" && side !== "sell") return { ok: false, error: "BAD_QUOTE" };
  if (side === "buy" ? q.inputMint !== SOL_MINT : q.outputMint !== SOL_MINT) return { ok: false, error: "BAD_QUOTE" };
  const inAmount = big(q.inAmount);
  const outAmount = big(q.outAmount);
  const balance = big(s.balanceLamports);
  if (inAmount === undefined || outAmount === undefined || balance === undefined) return { ok: false, error: "BAD_QUOTE" };
  if (inAmount <= 0n || outAmount <= 0n) return { ok: false, error: "BAD_QUOTE" };
  const mint = side === "buy" ? q.outputMint : q.inputMint;
  const net = demoNetworkLamports(q);
  const realized = BigInt(s.realizedLamports);
  const positions: Record<string, DemoPosition> = { ...s.positions };
  const prev = positions[mint];
  let nextBalance: bigint;
  let nextRealized = realized;
  let tradeRealized: string | undefined;

  if (side === "buy") {
    const spend = inAmount + net;
    if (spend > balance) return { ok: false, error: "LOW_SOL" };
    nextBalance = balance - spend;
    const raw = (prev ? BigInt(prev.raw) : 0n) + outAmount;
    const cost = (prev ? BigInt(prev.costLamports) : 0n) + spend;
    const iconUrl = prev?.iconUrl ?? meta.iconUrl;
    positions[mint] = {
      mint,
      symbol: prev?.symbol ?? meta.symbol,
      decimals: prev?.decimals ?? meta.decimals,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      raw: raw.toString(),
      costLamports: cost.toString(),
      openedAt: prev?.openedAt ?? now,
    };
  } else {
    const held = prev ? BigInt(prev.raw) : 0n;
    if (!prev || held <= 0n || inAmount > held) return { ok: false, error: "NO_HOLD" };
    const cost = BigInt(prev.costLamports);
    const proceeds = max0(outAmount - net);
    const released = (cost * inAmount) / held; // bigint floor division
    const pnl = proceeds - released;
    nextBalance = balance + proceeds;
    nextRealized = realized + pnl;
    tradeRealized = pnl.toString();
    const rest = held - inAmount;
    if (rest === 0n) delete positions[mint];
    else positions[mint] = { ...prev, raw: rest.toString(), costLamports: (cost - released).toString() };
  }

  const n = s.trades.filter((x) => x.at === now).length;
  const trade: DemoTrade = {
    id: `${now}-${n}`,
    at: now,
    mint,
    symbol: prev?.symbol ?? meta.symbol,
    side,
    inAmount: inAmount.toString(),
    outAmount: outAmount.toString(),
    outDecimals: q.outDecimals,
    networkLamports: net.toString(),
    feeUsd: q.cost.degenlyFeeUsd,
    feeBps: q.cost.degenlyFeeBps,
    ...(tradeRealized !== undefined ? { realizedLamports: tradeRealized } : {}),
  };
  const state: DemoStateV1 = {
    ...s,
    touchedAt: now,
    balanceLamports: nextBalance.toString(),
    realizedLamports: nextRealized.toString(),
    positions,
    trades: [trade, ...s.trades].slice(0, DEMO_TRADES_MAX),
    funnel: s.funnel.firstTradeAt === undefined ? { ...s.funnel, firstTradeAt: now } : s.funnel,
  };
  return { ok: true, state, trade };
}

// ---- exact decimal <-> raw units (no float) -------------------------------------------------

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Decimal string with up to `decimals` fraction digits → raw units (> 0), else undefined. */
export function parseUnits(v: string, decimals: number): bigint | undefined {
  const m = DECIMAL.exec(v.trim());
  if (!m) return undefined;
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) return undefined;
  const raw = BigInt(whole + frac.padEnd(decimals, "0"));
  return raw > 0n ? raw : undefined;
}

/** SOL as a decimal string ("0.1") → lamports, else undefined. */
export function parseSol(v: string): bigint | undefined {
  return parseUnits(v, SOL_DECIMALS);
}

/** Raw units (bigint or signed decimal string) → exact decimal string, trailing zeros trimmed. */
export function formatUnits(raw: bigint | string, decimals: number): string {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString();
  if (decimals === 0) return (neg ? "-" : "") + abs;
  const padded = abs.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? `.${frac}` : "");
}
