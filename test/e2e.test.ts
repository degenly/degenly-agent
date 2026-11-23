/**
 * DGAJ17: end to end, the way a human + an agent would use the package, against a FAKE Degenly (injected `fetch`):
 *   CLI setup --owner → pairing code → the fake site verifies the code (agent ed25519 signature over the pairing
 *   message, owner, terms versions) and issues an API key once → CLI login (key on stdin) → CLI whoami →
 *   MCP degenly_live_quote → MCP degenly_live_buy with the human's confirmation (form elicitation) → ONE execute,
 *   signed by the agent wallet over the quoted message.
 * The fake verifies every /v1 request like degenly/src/edge/botApi.ts:286-312. Temp home, no network.
 *
 * Optional live check (OFF by default, never part of `npm test`): DEGENLY_E2E=1 sends ONE unsigned
 * `GET https://degenly.app/v1/whoami` (budget: at most 3 requests) and accepts 401 (Bot API on) or 404 (Bot API off).
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/api.js";
import { createOps, runCli, type Answer, type LiveDeps } from "../src/cli.js";
import { AGENT_WALLET_WARNING } from "../src/keys.js";
import { createMcpServer } from "../src/mcp.js";
import { API_TERMS_VERSION, TERMS_VERSION, base58Decode, base58Encode, decodeAgentPairingCode } from "../src/sign.js";
import { CONFIRM_FIELD } from "../src/tools/confirm.js";
import { base64ToBytes, bytesToBase64, parseTxLayout } from "../src/tx.js";

const NOW = 1791594000000;
const OWNER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL = "So11111111111111111111111111111111111111112";
const TX_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const ISSUED_KEY = `dgk_${base58Encode(new Uint8Array(32).fill(7))}`;

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function edOk(address: string, msg: Uint8Array, sig: Uint8Array): boolean {
  const pk = base58Decode(address) ?? new Uint8Array(0);
  if (pk.length !== 32 || sig.length !== 64) return false;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk)]);
  return edVerify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
}

/** A minimal legacy Solana transaction with ONE signer (the agent) and one instruction; slot left empty. */
function unsignedTxFor(agent: string): Uint8Array {
  const agentKey = base58Decode(agent) ?? new Uint8Array(32);
  const program = new Uint8Array(32).fill(3);
  const blockhash = new Uint8Array(32).fill(5);
  return Uint8Array.from([1, ...new Uint8Array(64), 1, 0, 1, 2, ...agentKey, ...program, ...blockhash, 1, 1, 1, 0, 1, 9]);
}

/** Fake Degenly: the /bot pairing step (site side) + the /v1 Bot API. */
function fakeDegenly() {
  let paired: { agent: string; owner: string; apiKey: string } | undefined;
  let quotedTx: Uint8Array | undefined;
  const v1: { method: string; path: string; verified: boolean }[] = [];
  const executed: { signedOk: boolean; sameMessage: boolean; requestId: unknown }[] = [];

  /** What /bot "Pair agent" does with the pasted code (DGAJ7 rules, simplified): verify, then show the key once. */
  const pairOnSite = (code: string, signedInOwner: string): { ok: true; apiKey: string } | { ok: false; error: string } => {
    const d = decodeAgentPairingCode(code);
    if (!d) return { ok: false, error: "PAIR_CODE_INVALID" };
    const [agent, owner, nonce, ts, terms, apiTerms] = d.message.slice("degenly-agent-pair-v1:".length).split("|");
    if (!agent || owner !== signedInOwner || !nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, error: "PAIR_CODE_INVALID" };
    if (Math.abs(NOW - Number(ts)) > 600_000) return { ok: false, error: "PAIR_CODE_EXPIRED" };
    if (terms !== `terms:${TERMS_VERSION}` || apiTerms !== `apiTerms:${API_TERMS_VERSION}`) return { ok: false, error: "API_TERMS_REQUIRED" };
    if (!edOk(agent, new TextEncoder().encode(d.message), d.signature)) return { ok: false, error: "PAIR_SIGNATURE_INVALID" };
    paired = { agent, owner, apiKey: ISSUED_KEY };
    return { ok: true, apiKey: ISSUED_KEY };
  };

  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const path = u.pathname + u.search;
    const h = new Headers(init?.headers);
    const msg = `degenly-api-v1:${method}|${path}|${sha(body)}|${h.get("x-degenly-ts") ?? ""}`;
    const verified =
      paired !== undefined &&
      h.get("x-degenly-key") === paired.apiKey &&
      Math.abs(NOW - Number(h.get("x-degenly-ts"))) <= 30_000 &&
      edOk(paired.agent, new TextEncoder().encode(msg), base58Decode(h.get("x-degenly-sig") ?? "") ?? new Uint8Array(0));
    v1.push({ method, path, verified });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (!u.pathname.startsWith("/v1/")) return json(404, { ok: false, error: "NOT_FOUND" });
    if (!verified || !paired) return json(401, { ok: false, error: "KEY_INVALID" });
    if (u.pathname === "/v1/whoami") {
      return json(200, { ok: true, wallet: paired.agent, keyId: "k-e2e", bucket: "data", serverTs: NOW, limits: { perTradeLamports: "100000000", dailyLamports: "500000000", usedLamports: "0" } });
    }
    if (u.pathname === "/v1/data/tokens") {
      return json(200, { ok: true, data: [{ mint: u.searchParams.get("mints"), name: "Bonk", symbol: "BONK", decimals: 5, usdPrice: 0.00002, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }], untrustedFields: ["name", "symbol", "socials"] });
    }
    if (u.pathname === "/v1/quote") {
      const side = u.searchParams.get("side");
      quotedTx = unsignedTxFor(paired.agent);
      return json(200, {
        ok: true,
        quote: {
          requestId: "req-e2e",
          side,
          inputMint: side === "buy" ? SOL : BONK,
          outputMint: side === "buy" ? BONK : SOL,
          inAmount: u.searchParams.get("amount"),
          outAmount: "250000000",
          minOutAmount: "240000000",
          inDecimals: side === "buy" ? 9 : 5,
          outDecimals: side === "buy" ? 5 : 9,
          slippageAppliedPct: 3,
          expiresInMs: 30000,
          tradingEnabled: true,
          transaction: bytesToBase64(quotedTx),
          cost: { degenlyFeeBps: 100, networkAndPriorityLamports: 5000, priceImpactPct: 0.2 },
        },
      });
    }
    if (u.pathname === "/v1/execute") {
      const b = JSON.parse(body) as Record<string, unknown>;
      const signed = base64ToBytes(typeof b.signedTransaction === "string" ? b.signedTransaction : "") ?? new Uint8Array(0);
      const l = parseTxLayout(signed);
      const off = l?.messageOffset ?? 0;
      const slot = l ? l.signers.indexOf(paired.agent) : -1;
      executed.push({
        signedOk: l !== undefined && slot === 0 && edOk(paired.agent, signed.subarray(off), signed.subarray(1, 65)),
        sameMessage: quotedTx !== undefined && sha(signed.subarray(off)) === sha(quotedTx.subarray(off)),
        requestId: b.requestId,
      });
      return json(200, { ok: true, result: { status: "confirmed", signature: TX_SIG, totalInputAmount: "50000000", totalOutputAmount: "250000000" } });
    }
    return json(404, { ok: false, error: "NOT_FOUND" });
  };
  return { fetch, pairOnSite, v1, executed, paired: () => paired };
}

describe("DGAJ17 e2e (fake Degenly): setup → pairing code → login → whoami → quote → confirmed buy", () => {
  it("the whole path works, every /v1 request is signature-verified, and the buy is sent exactly once after the human confirms", async () => {
    const home = mkdtempSync(join(tmpdir(), "dgaj17-e2e-"));
    const site = fakeDegenly();
    let stdin = "";
    const live: LiveDeps = { home, env: {}, fetch: site.fetch, now: () => NOW, readStdin: async () => stdin };
    const demoFetch: FetchLike = async () => {
      throw new Error("the demo network must not be used in the live e2e");
    };
    const ops = createOps({ home, fetch: demoFetch, now: () => NOW });
    const cli = async (argv: string[]) => {
      const r = await runCli([...argv, "--json"], ops, live);
      return { code: r.code, a: JSON.parse(r.out) as Answer };
    };

    // 1. setup: agent wallet on this computer + pairing code + the warning; no network
    const s = await cli(["setup", "--owner", OWNER]);
    expect(s.code).toBe(0);
    expect(s.a).toMatchObject({ ok: true, mode: "live", ownerWallet: OWNER, warning: AGENT_WALLET_WARNING });
    expect(site.v1).toHaveLength(0);

    // 2. /bot → Pair agent: the site verifies the code and shows the key once
    const wrongOwner = site.pairOnSite(String(s.a.pairingCode), BONK);
    expect(wrongOwner).toEqual({ ok: false, error: "PAIR_CODE_INVALID" });
    const p = site.pairOnSite(String(s.a.pairingCode), OWNER);
    if (!p.ok) throw new Error(p.error);
    expect(site.paired()?.agent).toBe(s.a.address);

    // 3. login: the key on stdin (never an argument)
    expect((await cli(["login", p.apiKey])).a).toMatchObject({ ok: false, error: "KEY_ARG_REFUSED" });
    stdin = `${p.apiKey}\n`;
    const l = await cli(["login"]);
    expect(l.a).toMatchObject({ ok: true, mode: "live", address: s.a.address, keyPrefix: p.apiKey.slice(0, 12) });
    expect(JSON.stringify(l.a)).not.toContain(p.apiKey);

    // 4. whoami (CLI)
    const w = await cli(["whoami"]);
    expect(w.code).toBe(0);
    expect(w.a).toMatchObject({ ok: true, mode: "live", wallet: s.a.address, keyId: "k-e2e" });

    // 5-6. MCP: the live tools are listed now; quote, then a buy the human confirms
    const server = createMcpServer(ops, live);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "e2e", version: "0" }, { capabilities: { elicitation: { form: {} } } });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return { action: "accept", content: { [CONFIRM_FIELD]: true } };
    });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}") as Answer;
    };
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("degenly_live_buy");

    const q = await call("degenly_live_quote", { mint: BONK, side: "buy", amount: "0.05" });
    expect(q).toMatchObject({ ok: true, mode: "live", quoteOnly: true, inRaw: "50000000" });
    expect(site.executed).toHaveLength(0);

    const buy = await call("degenly_live_buy", { mint: BONK, sol: "0.05" });
    expect(buy).toMatchObject({ ok: true, mode: "live", status: "confirmed", txSignature: TX_SIG, confirm: "human", spent: "0.05", received: "2500" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`Token mint (the only reliable identity of the token): ${BONK}`);
    expect(asked[0]).toContain("You spend: 0.05 SOL");
    expect(site.executed).toEqual([{ signedOk: true, sameMessage: true, requestId: "req-e2e" }]);

    // every /v1 request of the run carried a valid agent signature; exactly one execute
    expect(site.v1.every((c) => c.verified)).toBe(true);
    expect(site.v1.filter((c) => c.path === "/v1/execute")).toHaveLength(1);
    expect(site.v1.map((c) => c.path.split("?")[0])).toEqual(["/v1/whoami", "/v1/data/tokens", "/v1/quote", "/v1/whoami", "/v1/data/tokens", "/v1/quote", "/v1/execute"]);

    // the demo side is untouched and still says demo
    expect(await call("degenly_status", {})).toMatchObject({ ok: true, mode: "demo" });
    await client.close();
  });
});

const LIVE_E2E = process.env.DEGENLY_E2E === "1";
const LIVE_REQUEST_BUDGET = 3;

describe("DGAJ17 e2e against degenly.app (only with DEGENLY_E2E=1)", () => {
  it.skipIf(!LIVE_E2E)("unsigned GET /v1/whoami → 401 (Bot API on) or 404 (Bot API off)", async () => {
    let sent = 0;
    const once = async (): Promise<number> => {
      if (sent >= LIVE_REQUEST_BUDGET) throw new Error("live request budget used up");
      sent++;
      const r = await fetch("https://degenly.app/v1/whoami", { method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
      return r.status;
    };
    const status = await once();
    // one line the report quotes as is
    console.log(`DGAJ17 live e2e: GET https://degenly.app/v1/whoami (unsigned) -> ${status} (${status === 404 ? "Bot API off" : status === 401 ? "Bot API on, request refused without key" : "unexpected"}); requests sent: ${sent}/${LIVE_REQUEST_BUDGET}`);
    expect([401, 404]).toContain(status);
    expect(sent).toBeLessThanOrEqual(LIVE_REQUEST_BUDGET);
  }, 30_000);
});
