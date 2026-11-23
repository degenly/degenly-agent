/**
 * DGAJ30: `degenly_live_withdraw` / `degenly withdraw` — SOL only back to the paired main wallet recorded on this
 * computer (~/.degenly/owner.json). A fake Degenly (injected `fetch`, no network) answers /v1/withdraw/prepare with
 * a hand-built legacy transaction (honest, or tampered: other destination, second instruction, other amount, v0)
 * and counts /v1/withdraw/send. Temp home: never the real ~/.degenly.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/api.js";
import { createOps, runCli, type Answer, type LiveDeps } from "../src/cli.js";
import { saveCredentials } from "../src/client.js";
import { createWallet, loadWallet } from "../src/keys.js";
import { LIVE_TOOLS, createMcpServer } from "../src/mcp.js";
import { base58Decode, base58Encode, type Signer } from "../src/sign.js";
import { WITHDRAW_CONFIRM_FIELD, WITHDRAW_NOT_CONFIRMED_TEXT, WITHDRAW_PAIRED_LINE, loadOwner, ownerPath, saveOwner, withdrawMessage } from "../src/tools/live-withdraw.js";
import { base64ToBytes, bytesToBase64, checkWithdrawTx, signWithdrawFor } from "../src/tx.js";

const NOW = 1791594000000;
const API_KEY = `dgk_${base58Encode(new Uint8Array(32).fill(9))}`;
const OWNER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TX_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const HALF_SOL = 500_000_000n;

// ---- a legacy transaction, built by hand (the server's own layout: agentWithdrawApi.ts buildAgentWithdrawTx) ----

const key = (a: string): number[] => [...(base58Decode(a) ?? new Uint8Array(32))];
function u64le(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (let k = 0; k < 8; k++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}
const transferData = (lamports: bigint): number[] => [12, 2, 0, 0, 0, ...u64le(lamports)];

interface TxOpts {
  to?: string;
  lamports?: bigint;
  /** a second instruction (Compute Budget SetComputeUnitPrice) */
  extraIx?: boolean;
  /** v0 message with an (empty) lookup table section */
  v0?: boolean;
  /** source = the destination account index (agent not the source) */
  wrongSource?: boolean;
}

function buildTx(agent: string, o: TxOpts = {}): Uint8Array {
  const to = o.to ?? OWNER;
  const keys = [agent, to, SYSTEM, ...(o.extraIx ? [COMPUTE_BUDGET] : [])];
  const ro = o.extraIx ? 2 : 1;
  const ixs: number[] = [];
  ixs.push(o.extraIx ? 2 : 1);
  ixs.push(2, 2, o.wrongSource ? 1 : 0, o.wrongSource ? 0 : 1, ...transferData(o.lamports ?? HALF_SOL));
  if (o.extraIx) ixs.push(3, 0, 9, 3, ...u64le(1000n));
  const msg = [...(o.v0 ? [0x80] : []), 1, 0, ro, keys.length, ...keys.flatMap(key), ...new Array<number>(32).fill(7), ...ixs, ...(o.v0 ? [0] : [])];
  return new Uint8Array([1, ...new Array<number>(64).fill(0), ...msg]);
}

function edOk(address: string, msg: Uint8Array, sig: Uint8Array): boolean {
  const pk = base58Decode(address) ?? new Uint8Array(0);
  if (pk.length !== 32 || sig.length !== 64) return false;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk)]);
  return edVerify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
}

// ---- fake Degenly ----------------------------------------------------------------------------------

type Reply = { status: number; body: unknown } | "network";

interface RigOpts {
  owner?: string | null; // null = no owner.json (an older setup)
  tx?: TxOpts;
  srvOwner?: string;
  srvLamports?: string;
  prepare?: Reply;
  send?: Reply;
  env?: Record<string, string>;
  interactive?: boolean;
  answer?: string;
}

function rig(o: RigOpts = {}) {
  const home = mkdtempSync(join(tmpdir(), "dgaj30-"));
  const c = createWallet(home);
  if (!c.ok) throw new Error("wallet");
  const agent = c.wallet.address;
  if (!saveCredentials(home, API_KEY)) throw new Error("credentials");
  if (o.owner !== null && !saveOwner(home, o.owner ?? OWNER)) throw new Error("owner");
  const calls: { method: string; path: string; body: string }[] = [];
  const sent: { signedOk: boolean; bytes: Uint8Array }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body });
    const reply = (r: Reply): Response => {
      if (r === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    };
    if (u.pathname === "/v1/withdraw/prepare") {
      if (o.prepare) return reply(o.prepare);
      const tx = buildTx(agent, o.tx);
      const lamports = o.srvLamports ?? (o.tx?.lamports ?? HALF_SOL).toString();
      return reply({ status: 200, body: { ok: true, transaction: bytesToBase64(tx), owner: o.srvOwner ?? o.tx?.to ?? OWNER, lamports, feeLamports: "5000" } });
    }
    if (u.pathname === "/v1/withdraw/send") {
      const b = JSON.parse(body) as Record<string, unknown>;
      const bytes = base64ToBytes(typeof b.signedTransaction === "string" ? b.signedTransaction : "") ?? new Uint8Array(0);
      sent.push({ bytes, signedOk: edOk(agent, bytes.subarray(65), bytes.subarray(1, 65)) });
      return reply(o.send ?? { status: 200, body: { ok: true, signature: TX_SIG } });
    }
    return reply({ status: 404, body: { ok: false, error: "NOT_FOUND" } });
  };
  const asked: string[] = [];
  const live: LiveDeps = {
    home,
    env: o.env ?? {},
    fetch,
    now: () => NOW,
    readStdin: async () => "",
    interactive: () => o.interactive === true,
    promptLine: async (q) => {
      asked.push(q);
      return o.answer ?? "YES";
    },
  };
  const ops = createOps({ home, fetch: async () => new Response("{}", { status: 500 }), now: () => NOW });
  const sends = () => calls.filter((x) => x.path === "/v1/withdraw/send").length;
  const prepares = () => calls.filter((x) => x.path === "/v1/withdraw/prepare").length;
  const cli = async (argv: string[]): Promise<Answer> => JSON.parse((await runCli([...argv, "--json"], ops, { ...live, interactive: () => false })).out) as Answer;
  const tty = async (argv: string[]) => {
    const r = await runCli(argv, ops, live);
    return { code: r.code, out: r.out };
  };
  return { home, agent, live, ops, calls, sent, sends, prepares, asked, cli, tty };
}

type ElicitFn = (message: string) => ElicitResult;
const accept: ElicitFn = () => ({ action: "accept", content: { [WITHDRAW_CONFIRM_FIELD]: true } });
const decline: ElicitFn = () => ({ action: "decline" });

async function mcp(r: ReturnType<typeof rig>, elicit?: ElicitFn) {
  const server = createMcpServer(r.ops, r.live);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  const asked: string[] = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return elicit(req.params.message);
    });
  }
  await client.connect(b);
  const call = async (args: Record<string, unknown>): Promise<Answer> => {
    const res = await client.callTool({ name: "degenly_live_withdraw", arguments: args });
    return JSON.parse((res.content as { type: string; text: string }[])[0]?.text ?? "") as Answer;
  };
  return { client, call, asked, close: () => client.close() };
}

function spySigner(s: Signer): { signer: Signer; count: () => number } {
  let n = 0;
  return { signer: { address: s.address, sign: (m) => (n++, s.sign(m)) }, count: () => n };
}

// ---- the owner record ------------------------------------------------------------------------------

describe("DGAJ30 owner record (~/.degenly/owner.json)", () => {
  it("setup writes it, pair with a new address replaces it; shape {v:1, owner}", async () => {
    const home = mkdtempSync(join(tmpdir(), "dgaj30-owner-"));
    const live: LiveDeps = { home, env: {}, fetch: async () => new Response("{}"), now: () => NOW, readStdin: async () => "" };
    const ops = createOps({ home, fetch: async () => new Response("{}"), now: () => NOW });
    const s = JSON.parse((await runCli(["setup", "--owner", OWNER, "--json"], ops, live)).out) as Answer;
    expect(s).toMatchObject({ ok: true, ownerFile: "~/.degenly/owner.json" });
    expect(JSON.parse(readFileSync(ownerPath(home), "utf8"))).toEqual({ v: 1, owner: OWNER });
    const p = JSON.parse((await runCli(["pair", "--owner", OTHER, "--json"], ops, live)).out) as Answer;
    expect(p.ok).toBe(true);
    expect(loadOwner(home)).toBe(OTHER);
  });

  it("no owner.json (older setup) → OWNER_UNKNOWN with the pair hint, nothing sent to the server", async () => {
    const r = rig({ owner: null });
    expect(existsSync(ownerPath(r.home))).toBe(false);
    const m = await mcp(r, accept);
    const a = await m.call({ amountSol: "0.5" });
    expect(a).toMatchObject({ ok: false, mode: "live", error: "OWNER_UNKNOWN" });
    expect(a.hint).toContain("Run: degenly pair --owner <main wallet address> (no new pairing is needed just to record it)");
    expect(r.calls.length).toBe(0);
    expect(m.asked.length).toBe(0);
    await m.close();
  });
});

// ---- the local check -------------------------------------------------------------------------------

describe("DGAJ30 local check: the server never chooses the destination", () => {
  it("server returns another destination (owner field + tx) → TX_REFUSED destination, nothing signed, send 0", async () => {
    const r = rig({ tx: { to: OTHER } });
    const m = await mcp(r, accept);
    const a = await m.call({ amountSol: "0.5" });
    expect(a).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "destination" });
    expect(r.prepares()).toBe(1);
    expect(r.sends()).toBe(0);
    expect(m.asked.length).toBe(0);
    await m.close();
  });

  it("server says the right owner but the tx pays someone else → TX_REFUSED destination, send 0", async () => {
    const r = rig({ tx: { to: OTHER }, srvOwner: OWNER });
    const m = await mcp(r, accept);
    expect(await m.call({ all: true })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "destination" });
    expect(r.sends()).toBe(0);
    await m.close();
  });

  it("server adds a second instruction → TX_REFUSED instructions, send 0", async () => {
    const r = rig({ tx: { extraIx: true } });
    const m = await mcp(r, accept);
    expect(await m.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "instructions" });
    expect(r.sends()).toBe(0);
    await m.close();
  });

  it("amount mismatch (server figure ≠ asked, or tx ≠ server figure) → TX_REFUSED amount, send 0", async () => {
    const r1 = rig({ tx: { lamports: 400_000_000n } });
    const m1 = await mcp(r1, accept);
    expect(await m1.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "amount" });
    await m1.close();
    const r2 = rig({ tx: { lamports: 400_000_000n }, srvLamports: "500000000" });
    const m2 = await mcp(r2, accept);
    expect(await m2.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "amount" });
    await m2.close();
    const r3 = rig({ tx: { lamports: 400_000_000n }, srvLamports: "500000000" });
    const m3 = await mcp(r3, accept);
    expect(await m3.call({ all: true })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "amount" });
    await m3.close();
    expect(r1.sends() + r2.sends() + r3.sends()).toBe(0);
  });

  it("v0 message → TX_REFUSED versioned; source ≠ agent → TX_REFUSED source", async () => {
    const r = rig({ tx: { v0: true } });
    const m = await mcp(r, accept);
    expect(await m.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "TX_REFUSED", reason: "versioned" });
    await m.close();
    const agent = r.agent;
    expect(checkWithdrawTx(buildTx(agent, { wrongSource: true }), agent, OWNER)).toEqual({ ok: false, reason: "source" });
    expect(r.sends()).toBe(0);
  });

  it("signWithdrawFor: a refused shape or amount is never signed (signer called 0 times); the honest one once", () => {
    const home = mkdtempSync(join(tmpdir(), "dgaj30-sign-"));
    createWallet(home);
    const w = loadWallet(home);
    if (!w.ok) throw new Error("wallet");
    const spy = spySigner(w.wallet);
    const a = w.wallet.address;
    for (const bad of [buildTx(a, { to: OTHER }), buildTx(a, { extraIx: true }), buildTx(a, { v0: true }), buildTx(a, { wrongSource: true }), buildTx(OTHER)]) {
      expect(signWithdrawFor(bad, spy.signer, OWNER, HALF_SOL).ok).toBe(false);
    }
    expect(signWithdrawFor(buildTx(a), spy.signer, OWNER, 1n)).toEqual({ ok: false, reason: "amount" });
    expect(spy.count()).toBe(0);
    const ok = signWithdrawFor(buildTx(a), spy.signer, OWNER, HALF_SOL);
    expect(ok.ok).toBe(true);
    expect(spy.count()).toBe(1);
    if (ok.ok) expect(edOk(a, ok.signed.subarray(65), ok.signed.subarray(1, 65))).toBe(true);
  });
});

// ---- confirmation + send ---------------------------------------------------------------------------

describe("DGAJ30 confirmation and the single send", () => {
  it("human declines → CANCELLED, send 0", async () => {
    const r = rig();
    const m = await mcp(r, decline);
    expect(await m.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "CANCELLED" });
    expect(m.asked.length).toBe(1);
    expect(r.sends()).toBe(0);
    await m.close();
  });

  it("human accepts → exactly 1 send of the agent-signed bytes; summary = amount, full address, paired line; body names no destination", async () => {
    const r = rig();
    const m = await mcp(r, accept);
    const a = await m.call({ amountSol: "0.5", to: OTHER, destination: OTHER });
    expect(a).toMatchObject({ ok: true, mode: "live", status: "sent", amountSol: "0.5", to: OWNER, txSignature: TX_SIG });
    expect(r.sends()).toBe(1);
    expect(r.sent[0]?.signedOk).toBe(true);
    expect(m.asked[0]).toContain("Amount: 0.5 SOL");
    expect(m.asked[0]).toContain(`To: ${OWNER}`);
    expect(m.asked[0]).toContain(WITHDRAW_PAIRED_LINE);
    expect(m.asked[0]).not.toContain("WARNING");
    expect(JSON.parse(r.calls.find((c) => c.path === "/v1/withdraw/prepare")?.body ?? "{}")).toEqual({ lamports: "500000000" });
    await m.close();
  });

  it("all: true → prepare {lamports:\"all\"}, the server's figure is shown and sent once", async () => {
    const r = rig({ tx: { lamports: 1_999_995_000n } });
    const m = await mcp(r, accept);
    expect(await m.call({ all: true })).toMatchObject({ ok: true, amountSol: "1.999995" });
    expect(JSON.parse(r.calls[0]?.body ?? "{}")).toEqual({ lamports: "all" });
    expect(r.sends()).toBe(1);
    await m.close();
  });

  it("network error on send → WITHDRAW_NOT_CONFIRMED with the balance hint, no retry (send tried exactly once)", async () => {
    const r = rig({ send: "network" });
    const m = await mcp(r, accept);
    const a = await m.call({ amountSol: "0.5" });
    expect(a).toMatchObject({ ok: false, error: "WITHDRAW_NOT_CONFIRMED", hint: WITHDRAW_NOT_CONFIRMED_TEXT });
    expect(r.sends()).toBe(1);
    const r5 = rig({ send: { status: 502, body: { ok: false, error: "SEND_FAILED" } } });
    const m5 = await mcp(r5, accept);
    expect(await m5.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "WITHDRAW_NOT_CONFIRMED" });
    expect(r5.sends()).toBe(1);
    await m.close();
    await m5.close();
  });

  it("DEGENLY_CONFIRM=off does NOT switch the confirmation off: no form → CONFIRM_UNSUPPORTED, send 0; with a form it still asks", async () => {
    const r = rig({ env: { DEGENLY_CONFIRM: "off" } });
    const m = await mcp(r);
    expect(await m.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "CONFIRM_UNSUPPORTED" });
    expect(r.sends()).toBe(0);
    await m.close();
    const r2 = rig({ env: { DEGENLY_CONFIRM: "off" } });
    const m2 = await mcp(r2, decline);
    expect(await m2.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "CANCELLED" });
    expect(m2.asked.length).toBe(1);
    expect(r2.sends()).toBe(0);
    await m2.close();
  });

  it("server flag off (404) → WITHDRAW_NOT_AVAILABLE, nothing more promised", async () => {
    const r = rig({ prepare: { status: 404, body: { ok: false, error: "NOT_FOUND" } } });
    const m = await mcp(r, accept);
    expect(await m.call({ amountSol: "0.5" })).toMatchObject({ ok: false, error: "WITHDRAW_NOT_AVAILABLE", hint: "Withdrawals are not switched on yet on this server." });
    expect(r.sends()).toBe(0);
    await m.close();
  });

  it("a foreign DEGENLY_API_BASE puts the warning on the summary's first line", () => {
    const t = withdrawMessage({ amountSol: "1", feeSol: "0.000005", owner: OWNER, apiBase: "https://evil.example" });
    expect(t.split("\n")[0]).toBe("WARNING: this withdrawal is prepared by https://evil.example, not degenly.app.");
  });
});

// ---- the MCP schema + the CLI ----------------------------------------------------------------------

describe("DGAJ30 tool schema and CLI", () => {
  it("degenly_live_withdraw: only amountSol / all in the schema, no destination argument, additionalProperties false", () => {
    const t = LIVE_TOOLS.find((x) => x.name === "degenly_live_withdraw");
    expect(t).toBeDefined();
    const props = Object.keys((t?.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(props.sort()).toEqual(["all", "amountSol"]);
    expect(props.filter((k) => /to|dest|address|owner|recipient|wallet/i.test(k))).toEqual([]);
    expect(t?.inputSchema.additionalProperties).toBe(false);
    expect(t?.description).toContain("Funds can only go back to your paired main wallet");
  });

  it("amountSol and all together, or neither → BAD_AMOUNT, nothing sent", async () => {
    const r = rig();
    const m = await mcp(r, accept);
    expect(await m.call({ amountSol: "0.5", all: true })).toMatchObject({ ok: false, error: "BAD_AMOUNT" });
    expect(await m.call({})).toMatchObject({ ok: false, error: "BAD_AMOUNT" });
    expect(await m.call({ amountSol: "all" })).toMatchObject({ ok: false, error: "BAD_AMOUNT" });
    expect(r.calls.length).toBe(0);
    await m.close();
  });

  it("CLI outside an interactive terminal, or with --json → WITHDRAW_NEEDS_TERMINAL pointing at the MCP tool; no request", async () => {
    const r = rig();
    const a = await r.cli(["withdraw", "0.5"]);
    expect(a).toMatchObject({ ok: false, mode: "live", error: "WITHDRAW_NEEDS_TERMINAL" });
    expect(a.hint).toContain("degenly_live_withdraw");
    const j = await runCli(["withdraw", "all", "--json"], r.ops, r.live); // interactive() false here too
    expect(JSON.parse(j.out)).toMatchObject({ error: "WITHDRAW_NEEDS_TERMINAL" });
    const r2 = rig({ interactive: true });
    const j2 = await runCli(["withdraw", "all", "--json"], r2.ops, r2.live);
    expect(JSON.parse(j2.out)).toMatchObject({ error: "WITHDRAW_NEEDS_TERMINAL" });
    expect(r.calls.length + r2.calls.length).toBe(0);
    expect(r2.asked.length).toBe(0);
  });

  it("CLI in a terminal: YES sends once; anything else (yes, y) sends nothing", async () => {
    const r = rig({ interactive: true, answer: "YES" });
    const ok = await r.tty(["withdraw", "0.5"]);
    expect(ok.code).toBe(0);
    expect(r.asked[0]).toContain(`To: ${OWNER}`);
    expect(r.asked[0]).toContain("Type YES to send");
    expect(r.sends()).toBe(1);
    for (const answer of ["yes", "y", ""]) {
      const n = rig({ interactive: true, answer });
      const out = await n.tty(["withdraw", "0.5"]);
      expect(out.out).toContain("CANCELLED");
      expect(n.sends()).toBe(0);
    }
  });
});
