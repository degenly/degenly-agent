/**
 * DGAJD1: the demo fill must give the SAME result as the site's `demoFill`
 * (degenly/src/demo/fill.ts). Vectors copied AS IS from degenly/src/demo/dgdemo1.test.ts.
 *
 * Fixture = the site's `fixtureQuote("metisPump")` (recorded Jupiter /order, mapped):
 * inAmount 10000000, outAmount 294146076398, outDecimals 6, networkAndPriorityLamports 1499170,
 * rentLamports 1488440, degenlyFeeBps 100. `degenlyFeeUsd` is display only (any value > 0 behaves the same).
 */
import { describe, expect, it } from "vitest";
import { QUOTE_MAX_AGE_MS, SOL_MINT, demoFill, formatUnits, parseSol, type DemoQuote, type DemoTokenMeta } from "../src/demo/fill.js";
import { DEMO_START_LAMPORTS, DEMO_TRADES_MAX, newDemo, type DemoStateV1, type DemoTrade } from "../src/demo/store.js";

const FIXTURE_PUMP_MINT = "EyvEA8qgNtSu56MRErRuzbiKNgGQaVeUsT89qRNtpump";
const NOW = 1_000_000;
const META: DemoTokenMeta = { symbol: "PUMP", decimals: 6 };

function metisPump(): DemoQuote {
  return {
    side: "buy",
    inputMint: SOL_MINT,
    outputMint: FIXTURE_PUMP_MINT,
    inAmount: "10000000",
    outAmount: "294146076398",
    inDecimals: 9,
    outDecimals: 6,
    cost: { degenlyFeeBps: 100, degenlyFeeUsd: 0.0109304392998643, networkAndPriorityLamports: 1_499_170, rentLamports: 1_488_440 },
  };
}

function buyQuote(o: Partial<DemoQuote> = {}, receivedAt = NOW): DemoQuote & { receivedAt: number } {
  return { ...metisPump(), ...o, receivedAt };
}

function sellQuote(inAmount: string, outAmount: string, receivedAt = NOW): DemoQuote & { receivedAt: number } {
  const b = metisPump();
  return { ...b, side: "sell", inputMint: FIXTURE_PUMP_MINT, outputMint: SOL_MINT, inAmount, outAmount, inDecimals: 6, outDecimals: 9, receivedAt };
}

function fresh(): DemoStateV1 {
  return { ...newDemo(NOW), active: true };
}

function boughtState(): DemoStateV1 {
  const r = demoFill(fresh(), buyQuote(), META, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

describe("DGAJD1 demo fill = site demoFill (dgdemo1 vectors)", () => {
  it("V1 buy from 10 SOL → balance 9989989270, raw 294146076398, cost 10010730", () => {
    const s = fresh();
    expect(s.balanceLamports).toBe(DEMO_START_LAMPORTS.toString());
    expect(DEMO_START_LAMPORTS).toBe(10_000_000_000n);
    const r = demoFill(s, buyQuote(), META, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.balanceLamports).toBe("9989989270");
    const p = r.state.positions[FIXTURE_PUMP_MINT];
    expect(p?.raw).toBe("294146076398");
    expect(p?.costLamports).toBe("10010730");
    expect(p?.symbol).toBe("PUMP");
    expect(r.trade.side).toBe("buy");
    expect(r.state.trades[0]).toEqual(r.trade);
    expect(r.state.funnel.firstTradeAt).toBe(NOW);
  });

  it("V2 sell half → released 5005365, realized +983905", () => {
    const half = demoFill(boughtState(), sellQuote("147073038199", "6000000"), META, NOW + 1);
    expect(half.ok).toBe(true);
    if (!half.ok) return;
    expect(half.trade.realizedLamports).toBe("983905");
    expect(half.state.realizedLamports).toBe("983905");
    expect(half.state.balanceLamports).toBe((9_989_989_270n + 5_989_270n).toString());
    expect(half.state.positions[FIXTURE_PUMP_MINT]?.raw).toBe("147073038199");
    expect(half.state.positions[FIXTURE_PUMP_MINT]?.costLamports).toBe("5005365");
  });

  it("V3 sell rest → position removed (full sell)", () => {
    const half = demoFill(boughtState(), sellQuote("147073038199", "6000000"), META, NOW + 1);
    if (!half.ok) throw new Error(half.error);
    const rest = demoFill(half.state, sellQuote("147073038199", "6000000"), META, NOW + 2);
    expect(rest.ok).toBe(true);
    if (!rest.ok) return;
    expect(rest.state.positions[FIXTURE_PUMP_MINT]).toBeUndefined();
    expect(Object.keys(rest.state.positions)).toHaveLength(0);
    expect(rest.state.trades.map((t) => t.side)).toEqual(["sell", "sell", "buy"]);
    expect(rest.state.funnel.firstTradeAt).toBe(NOW);
  });

  it("V4 Degenly fee is never subtracted twice (outAmount used as is)", () => {
    const q = buyQuote();
    const r = demoFill(fresh(), q, META, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.state.positions[FIXTURE_PUMP_MINT]?.raw).toBe(q.outAmount);
    expect(r.trade.feeUsd).toBe(q.cost.degenlyFeeUsd);
    expect(r.trade.feeBps).toBe(q.cost.degenlyFeeBps);
    const sell = demoFill(r.state, sellQuote(q.outAmount, "9000000"), META, NOW + 1);
    if (!sell.ok) throw new Error(sell.error);
    expect(BigInt(sell.state.balanceLamports) - BigInt(r.state.balanceLamports)).toBe(9_000_000n - 10_730n);
  });

  it("V5 LOW_SOL / NO_HOLD / STALE_QUOTE (>15 s) / BAD_QUOTE leave the state unchanged", () => {
    const s = boughtState();
    const before = JSON.stringify(s);
    const poor: DemoStateV1 = { ...s, balanceLamports: "10000000" };
    expect(demoFill(poor, buyQuote(), META, NOW)).toEqual({ ok: false, error: "LOW_SOL" });
    expect(demoFill(s, sellQuote("294146076399", "1"), META, NOW)).toEqual({ ok: false, error: "NO_HOLD" });
    expect(demoFill(fresh(), sellQuote("1", "1"), META, NOW)).toEqual({ ok: false, error: "NO_HOLD" });
    expect(QUOTE_MAX_AGE_MS).toBe(15_000);
    expect(demoFill(s, buyQuote({}, NOW - 15_001), META, NOW)).toEqual({ ok: false, error: "STALE_QUOTE" });
    expect(demoFill(s, buyQuote({}, NOW - 15_000), META, NOW).ok).toBe(true);
    expect(demoFill(s, buyQuote({ inputMint: FIXTURE_PUMP_MINT }), META, NOW)).toEqual({ ok: false, error: "BAD_QUOTE" });
    expect(demoFill(s, { ...sellQuote("1", "1"), outputMint: FIXTURE_PUMP_MINT }, META, NOW)).toEqual({ ok: false, error: "BAD_QUOTE" });
    expect(demoFill(s, buyQuote({ outAmount: "0" }), META, NOW)).toEqual({ ok: false, error: "BAD_QUOTE" });
    expect(demoFill(s, buyQuote({ outAmount: "12.5" }), META, NOW)).toEqual({ ok: false, error: "BAD_QUOTE" });
    expect(demoFill(s, buyQuote({ inAmount: "abc" }), META, NOW)).toEqual({ ok: false, error: "BAD_QUOTE" });
    expect(JSON.stringify(s)).toBe(before);
  });

  it("V6 rent is not charged; network = networkAndPriority − rent; never below 0", () => {
    const q = buyQuote();
    const r = demoFill(fresh(), q, META, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.trade.networkLamports).toBe("10730");
    expect(DEMO_START_LAMPORTS - BigInt(r.state.balanceLamports)).toBe(10_000_000n + 10_730n);
    const noRent = demoFill(fresh(), buyQuote({ cost: { ...q.cost, rentLamports: undefined } }), META, NOW);
    if (!noRent.ok) throw new Error(noRent.error);
    expect(noRent.trade.networkLamports).toBe("1499170");
    const neg = demoFill(fresh(), buyQuote({ cost: { ...q.cost, networkAndPriorityLamports: 0 } }), META, NOW);
    if (!neg.ok) throw new Error(neg.error);
    expect(neg.trade.networkLamports).toBe("0");
  });

  it("V7 trades capped at 200, newest first", () => {
    const filler: DemoTrade[] = Array.from({ length: DEMO_TRADES_MAX }, (_, i) => ({
      id: `${i}-0`,
      at: i,
      mint: FIXTURE_PUMP_MINT,
      symbol: "PUMP",
      side: "buy",
      inAmount: "1",
      outAmount: "1",
      outDecimals: 6,
      networkLamports: "0",
      feeUsd: 0,
      feeBps: 100,
    }));
    const s: DemoStateV1 = { ...fresh(), trades: [...filler].reverse() };
    const r = demoFill(s, buyQuote(), META, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(DEMO_TRADES_MAX).toBe(200);
    expect(r.state.trades).toHaveLength(DEMO_TRADES_MAX);
    expect(r.state.trades[0]?.at).toBe(NOW);
    expect(r.state.trades.some((t) => t.at === 0)).toBe(false);
  });
});

describe("DGAJD1 amounts are bigint / decimal strings (no float money math)", () => {
  it("parseSol: decimal SOL string → lamports; rejects floats-as-numbers, > 9 decimals, 0, junk", () => {
    expect(parseSol("0.1")).toBe(100_000_000n);
    expect(parseSol("10")).toBe(10_000_000_000n);
    expect(parseSol("0.000000001")).toBe(1n);
    expect(parseSol("0.0000000001")).toBeUndefined();
    expect(parseSol("0")).toBeUndefined();
    expect(parseSol("-1")).toBeUndefined();
    expect(parseSol("1e3")).toBeUndefined();
    expect(parseSol("abc")).toBeUndefined();
    expect(parseSol("")).toBeUndefined();
  });
  it("formatUnits: exact decimal string, trailing zeros trimmed", () => {
    expect(formatUnits(10_000_000_000n, 9)).toBe("10");
    expect(formatUnits("9989989270", 9)).toBe("9.98998927");
    expect(formatUnits("294146076398", 6)).toBe("294146.076398");
    expect(formatUnits("-983905", 9)).toBe("-0.000983905");
    expect(formatUnits("5", 0)).toBe("5");
    expect(formatUnits("123456789012345678901234567890", 9)).toBe("123456789012345678901.23456789");
  });
});
