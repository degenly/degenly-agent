/**
 * DGAJD1: the demo record. Lives ONLY on this computer, in `~/.degenly/demo.json` (the user's home directory,
 * never the working directory). Nothing of it is sent anywhere: no balance, no position, no trade
 * (same rule as the site's demo, degenly/src/demo/store.ts).
 *
 * Shape = the site's `DemoStateV1` (same field names, same validation), so the two stay comparable.
 * Amounts are decimal strings (lamports / token raw units can exceed 2^53); math is bigint (`./fill`).
 * A corrupt / incompatible file is renamed to `demo.json.corrupt-<ms>` and a fresh 10 SOL record starts (no crash).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEMO_DIR_NAME = ".degenly";
export const DEMO_FILE_NAME = "demo.json";
/** degenly.app demo start balance (site `DEMO_MAIN_START_LAMPORTS`): 10 SOL. */
export const DEMO_START_LAMPORTS = 10_000_000_000n;
export const DEMO_TRADES_MAX = 200; // oldest drops

export interface DemoPosition {
  mint: string;
  symbol: string;
  decimals: number;
  iconUrl?: string;
  /** token raw units, decimal string */
  raw: string;
  /** remaining cost basis in lamports (SOL spent incl. network), decimal string */
  costLamports: string;
  openedAt: number;
}

export interface DemoTrade {
  id: string; // `${at}-${n}`
  at: number;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  inAmount: string;
  outAmount: string;
  outDecimals: number;
  networkLamports: string; // charged (networkAndPriority − rent)
  feeUsd: number; // display only, already inside outAmount
  feeBps: number;
  /** sell only: proceeds − released cost, lamports, signed decimal string */
  realizedLamports?: string;
}

export interface DemoStateV1 {
  v: 1;
  startedAt: number;
  touchedAt: number;
  active: boolean;
  startedSignedOut: boolean;
  balanceLamports: string;
  realizedLamports: string; // signed sum
  positions: Record<string, DemoPosition>; // key = mint
  trades: DemoTrade[]; // newest first
  funnel: { firstTradeAt?: number; goLiveAt?: number };
  /** the start balance this record was opened with (lamports) */
  base?: string;
}

// ---- validation (same rules as the site's parseDemo; the site-only `pinnedCard` is ignored if present) ----

const UINT = /^\d+$/;
const INT = /^-?\d+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isUint(v: unknown): v is string {
  return typeof v === "string" && UINT.test(v);
}
function isInt(v: unknown): v is string {
  return typeof v === "string" && INT.test(v);
}

function validPosition(key: string, v: unknown): v is DemoPosition {
  return (
    isObj(v) &&
    v.mint === key &&
    typeof v.symbol === "string" &&
    isNum(v.decimals) &&
    (v.iconUrl === undefined || typeof v.iconUrl === "string") &&
    isUint(v.raw) &&
    isUint(v.costLamports) &&
    isNum(v.openedAt)
  );
}

function validTrade(v: unknown): v is DemoTrade {
  return (
    isObj(v) &&
    typeof v.id === "string" &&
    isNum(v.at) &&
    typeof v.mint === "string" &&
    typeof v.symbol === "string" &&
    (v.side === "buy" || v.side === "sell") &&
    isUint(v.inAmount) &&
    isUint(v.outAmount) &&
    isNum(v.outDecimals) &&
    isUint(v.networkLamports) &&
    isNum(v.feeUsd) &&
    isNum(v.feeBps) &&
    (v.realizedLamports === undefined || isInt(v.realizedLamports))
  );
}

/** Shape check only: a stored value we can trust, or undefined. */
export function parseDemo(raw: string): DemoStateV1 | undefined {
  if (raw === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(v) || v.v !== 1) return undefined;
  if (!isNum(v.startedAt) || !isNum(v.touchedAt) || typeof v.active !== "boolean" || typeof v.startedSignedOut !== "boolean") return undefined;
  if (!isUint(v.balanceLamports) || !isInt(v.realizedLamports)) return undefined;
  if (!isObj(v.positions) || !Object.entries(v.positions).every(([k, p]) => validPosition(k, p))) return undefined;
  if (!Array.isArray(v.trades) || !v.trades.every(validTrade)) return undefined;
  const f = v.funnel;
  if (!isObj(f) || (f.firstTradeAt !== undefined && !isNum(f.firstTradeAt)) || (f.goLiveAt !== undefined && !isNum(f.goLiveAt))) return undefined;
  if (v.base !== undefined && !isUint(v.base)) return undefined;
  return v as unknown as DemoStateV1;
}

// ---- record API ---------------------------------------------------------------------------------

/** A fresh 10 SOL record. `startedSignedOut` is true: the package never has a wallet in demo mode. */
export function newDemo(now: number): DemoStateV1 {
  const start = DEMO_START_LAMPORTS.toString();
  return {
    v: 1,
    startedAt: now,
    touchedAt: now,
    active: true,
    startedSignedOut: true,
    balanceLamports: start,
    realizedLamports: "0",
    positions: {},
    trades: [],
    funnel: {},
    base: start,
  };
}

/** Reset: a fresh 10 SOL record; `startedAt`, `startedSignedOut` and `funnel` kept (site `resetDemo` rule). */
export function resetDemo(prev: DemoStateV1, now: number): DemoStateV1 {
  return { ...newDemo(now), startedSignedOut: prev.startedSignedOut, startedAt: prev.startedAt, funnel: { ...prev.funnel } };
}

export function demoDir(home: string): string {
  return join(home, DEMO_DIR_NAME);
}

export function demoPath(home: string): string {
  return join(demoDir(home), DEMO_FILE_NAME);
}

export interface LoadedDemo {
  state: DemoStateV1;
  /** true = there was no usable record; a fresh one was written */
  created: boolean;
  /** a corrupt record was moved here before starting fresh */
  recoveredFrom?: string;
}

/** The stored record; none → a fresh 10 SOL one is written; corrupt → backed up + fresh. Never throws on bad content. */
export function loadDemo(home: string, now: number): LoadedDemo {
  const file = demoPath(home);
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    const s = parseDemo(raw);
    if (s) return { state: s, created: false };
    const backup = `${file}.corrupt-${now}`;
    renameSync(file, backup);
    const fresh = newDemo(now);
    saveDemo(home, fresh);
    return { state: fresh, created: true, recoveredFrom: backup };
  }
  const fresh = newDemo(now);
  saveDemo(home, fresh);
  return { state: fresh, created: true };
}

/** One write of the full record via a temp file + rename (no half-written file). false = the disk refused. */
export function saveDemo(home: string, s: DemoStateV1): boolean {
  try {
    mkdirSync(demoDir(home), { recursive: true, mode: 0o700 });
    const file = demoPath(home);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
