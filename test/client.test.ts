/**
 * DGAJ15: the `/v1/*` client + the live CLI commands (setup / login / whoami / pair).
 * Injected `fetch` + temp home: no network, never the real ~/.degenly.
 * The fake server below verifies every request exactly like degenly/src/edge/botApi.ts:286-312
 * (headers → ts skew → key → Ed25519 over `degenly-api-v1:METHOD|pathname+search|sha256(body)|ts`).
 */
import { createHash, webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/api.js";
import { createOps, runCli, type LiveDeps } from "../src/cli.js";
import { CREDENTIALS_FILE_NAME, DEFAULT_API_BASE, LIVE_NOT_AVAILABLE, createLiveClient, loadCredentials, resolveApiBase } from "../src/client.js";
import { AGENT_WALLET_WARNING, loadWallet, walletPath } from "../src/keys.js";
import { base58Decode, base58Encode, decodeAgentPairingCode } from "../src/sign.js";

const OWNER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = 1791594000000;
const API_KEY = `dgk_${base58Encode(new Uint8Array(32).fill(9))}`;
const POSIX = process.platform !== "win32";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function bodyBytes(init: RequestInit | undefined): Uint8Array {
  const b = init?.body;
  if (b === undefined || b === null) return new Uint8Array(0);
  if (typeof b === "string") return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  throw new Error("unexpected body type");
}

/** Fake Degenly: server-side verification, then `answer(path)` for a verified request. */
function fakeServer(o: { answer?: (path: string) => { status: number; body: unknown; headers?: Record<string, string> }; wallet?: () => string | undefined } = {}) {
  const calls: Captured[] = [];
  const verified: boolean[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = bodyBytes(init);
    const h = headersOf(init);
    calls.push({ url, method: init?.method ?? "GET", headers: h, body: new TextDecoder().decode(body) });
    const u = new URL(url);
    const wallet = o.wallet?.();
    let ok = false;
    if (wallet && h["x-degenly-key"] === API_KEY && /^\d{1,16}$/.test(h["x-degenly-ts"] ?? "") && Math.abs(NOW - Number(h["x-degenly-ts"])) <= 30_000) {
      const hash = createHash("sha256").update(body).digest("hex");
      const msg = new TextEncoder().encode(`degenly-api-v1:${(init?.method ?? "GET").toUpperCase()}|${u.pathname + u.search}|${hash}|${h["x-degenly-ts"]}`);
      const pk = base58Decode(wallet) ?? new Uint8Array(0);
      const sig = base58Decode(h["x-degenly-sig"] ?? "") ?? new Uint8Array(0);
      if (pk.length === 32 && sig.length === 64) {
        const key = await webcrypto.subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]);
        ok = await webcrypto.subtle.verify({ name: "Ed25519" }, key, sig, msg);
      }
    }
    verified.push(ok);
    if (!ok) return new Response(JSON.stringify({ ok: false, error: "SIGNATURE_INVALID" }), { status: 401 });
    const a = o.answer?.(u.pathname) ?? { status: 200, body: { ok: true, wallet, keyId: "k1", bucket: "data", serverTs: NOW } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json", ...(a.headers ?? {}) } });
  };
  return { fetch, calls, verified };
}

function rig(o: { stdin?: string; env?: Record<string, string>; answer?: (path: string) => { status: number; body: unknown; headers?: Record<string, string> } } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dgaj15-cli-"));
  const server = fakeServer({ answer: o.answer, wallet: () => { const w = loadWallet(home); return w.ok ? w.wallet.address : undefined; } });
  let stdinReads = 0;
  const live: LiveDeps = {
    home,
    env: o.env ?? {},
    fetch: server.fetch,
    now: () => NOW,
    readStdin: async () => {
      stdinReads++;
      return o.stdin ?? "";
    },
  };
  const demoFetch: FetchLike = async () => {
    throw new Error("demo network must not be used here");
  };
  const ops = createOps({ home, fetch: demoFetch, now: () => NOW });
  const cli = (argv: string[]) => runCli(argv, ops, live);
  return { home, live, ops, cli, server, stdinReads: () => stdinReads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DGAJ15 client: API base", () => {
  it("default https://degenly.app; DEGENLY_API_BASE only https (no user info / query / path)", () => {
    expect(DEFAULT_API_BASE).toBe("https://degenly.app");
    expect(resolveApiBase({})).toEqual({ ok: true, base: "https://degenly.app" });
    expect(resolveApiBase({ DEGENLY_API_BASE: "https://staging.degenly.app/" })).toEqual({ ok: true, base: "https://staging.degenly.app" });
    for (const bad of ["http://degenly.app", "http://localhost:8787", "ftp://degenly.app", "file:///etc/passwd", "degenly.app", "https://u:p@degenly.app", "https://degenly.app/x", "https://degenly.app?a=1", "javascript:alert(1)"]) {
      expect(resolveApiBase({ DEGENLY_API_BASE: bad }), bad).toEqual({ ok: false, error: "BAD_API_BASE" });
    }
  });

  it("whoami with DEGENLY_API_BASE=http://... → BAD_API_BASE, zero network calls", async () => {
    const r = rig({ env: { DEGENLY_API_BASE: "http://127.0.0.1:8787" }, stdin: API_KEY });
    expect((await r.cli(["setup", "--owner", OWNER, "--json"])).code).toBe(0);
    expect((await r.cli(["login", "--json"])).code).toBe(0);
    const w = await r.cli(["whoami", "--json"]);
    expect(JSON.parse(w.out)).toMatchObject({ ok: false, mode: "live", error: "BAD_API_BASE" });
    expect(w.code).not.toBe(0);
    expect(r.server.calls).toHaveLength(0);
  });
});

describe("DGAJ15 client: signed requests + server error bodies", () => {
  it("GET with a query and POST with a body pass the server's verification; redirects are refused", async () => {
    const r = rig({ stdin: API_KEY });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    const w = loadWallet(r.home);
    if (!w.ok) throw new Error("no wallet");
    const c = createLiveClient({ fetch: r.server.fetch, base: DEFAULT_API_BASE, apiKey: API_KEY, signer: w.wallet, now: () => NOW });
    const g = await c.request("GET", "/v1/quote?mint=a&side=buy&amount=1");
    expect(g.ok).toBe(true);
    const p = await c.request("POST", "/v1/execute", '{"signedTransaction":"AQ==","requestId":"r1"}');
    expect(p.ok).toBe(true);
    expect(r.server.verified).toEqual([true, true]);
    expect(r.server.calls[0]?.url).toBe("https://degenly.app/v1/quote?mint=a&side=buy&amount=1");
    expect(r.server.calls[1]?.headers["content-type"]).toBe("application/json");
    // non-/v1 paths are not sent
    expect(await c.request("GET", "/api/apikeys")).toMatchObject({ ok: false, error: "BAD_PATH" });
    expect(await c.request("GET", "https://evil.example/v1/whoami")).toMatchObject({ ok: false, error: "BAD_PATH" });
    expect(r.server.calls).toHaveLength(2);
  });

  it("redirect: 'error' on every request (a redirect never carries the key elsewhere)", async () => {
    const inits: Array<RequestInit | undefined> = [];
    const f: FetchLike = async (_u, init) => {
      inits.push(init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const home = mkdtempSync(join(tmpdir(), "dgaj15-redir-"));
    const r = rig();
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    const w = loadWallet(r.home);
    if (!w.ok) throw new Error("no wallet");
    await createLiveClient({ fetch: f, base: DEFAULT_API_BASE, apiKey: API_KEY, signer: w.wallet, now: () => NOW }).request("GET", "/v1/whoami");
    expect(inits[0]?.redirect).toBe("error");
    expect(existsSync(home)).toBe(true);
  });

  it("server error bodies come back as is, with the server's stable error code", async () => {
    const cases: Array<{ status: number; body: Record<string, unknown>; headers?: Record<string, string>; expect: Record<string, unknown> }> = [
      { status: 403, body: { ok: false, error: "SPEND_LIMIT", scope: "day", limitLamports: "500000000", usedLamports: "450000000", resetMs: 1000 }, expect: { error: "SPEND_LIMIT", status: 403, scope: "day", limitLamports: "500000000", usedLamports: "450000000", resetMs: 1000 } },
      { status: 403, body: { ok: false, error: "SPEND_LIMIT", scope: "trade", limitLamports: "100000000" }, expect: { error: "SPEND_LIMIT", scope: "trade", limitLamports: "100000000" } },
      { status: 403, body: { ok: false, error: "SPEND_LIMIT_NOT_SET" }, expect: { error: "SPEND_LIMIT_NOT_SET", status: 403 } },
      { status: 403, body: { ok: false, error: "TOKEN_BLOCKED", reason: "FREEZE_AUTHORITY" }, expect: { error: "TOKEN_BLOCKED", reason: "FREEZE_AUTHORITY" } },
      { status: 503, body: { ok: false, error: "API_BUDGET_EXHAUSTED" }, headers: { "Retry-After": "3600" }, expect: { error: "API_BUDGET_EXHAUSTED", status: 503, retryAfterMs: 3_600_000 } },
      { status: 409, body: { ok: false, error: "API_SEATS_FULL" }, expect: { error: "API_SEATS_FULL", status: 409 } },
      { status: 401, body: { ok: false, error: "KEY_INVALID" }, expect: { error: "KEY_INVALID", status: 401 } },
      { status: 401, body: { ok: false, error: "TS_SKEW", serverTs: 5 }, expect: { error: "TS_SKEW", serverTs: 5 } },
      { status: 404, body: { ok: false, error: "NOT_FOUND" }, expect: { error: "NOT_FOUND", status: 404, hint: LIVE_NOT_AVAILABLE } },
      { status: 404, body: { nonsense: true }, expect: { error: "NOT_FOUND", status: 404, hint: LIVE_NOT_AVAILABLE } },
      { status: 500, body: { ok: false, error: "bad\ncode\u202e" }, expect: { status: 500 } },
    ];
    for (const k of cases) {
      const r = rig({ stdin: API_KEY, answer: () => ({ status: k.status, body: k.body, headers: k.headers }) });
      await r.cli(["setup", "--owner", OWNER, "--json"]);
      await r.cli(["login", "--json"]);
      const out = await r.cli(["whoami", "--json"]);
      const a = JSON.parse(out.out) as Record<string, unknown>;
      expect(a, JSON.stringify(k.body)).toMatchObject({ ok: false, mode: "live", ...k.expect });
      expect(typeof a.hint).toBe("string");
      expect(out.code).not.toBe(0);
      expect(String(a.error)).toMatch(/^[A-Z0-9_]+$/);
    }
    expect(LIVE_NOT_AVAILABLE).toBe("Live trading is not available yet.");
  });

  it("network failure → NETWORK", async () => {
    const r = rig({ stdin: API_KEY });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    await r.cli(["login", "--json"]);
    r.live.fetch = async () => {
      throw new Error("offline");
    };
    expect(JSON.parse((await r.cli(["whoami", "--json"])).out)).toMatchObject({ ok: false, mode: "live", error: "NETWORK" });
  });
});

describe("DGAJ15 CLI: setup", () => {
  it("prints the address, the pairing code, the warning word for word and the next step; the code verifies", async () => {
    const r = rig();
    const s = await r.cli(["setup", "--owner", OWNER, "--json"]);
    expect(s.code).toBe(0);
    expect(s.out.split("\n")).toHaveLength(1);
    const a = JSON.parse(s.out) as Record<string, unknown>;
    expect(a).toMatchObject({ ok: true, mode: "live", ownerWallet: OWNER, warning: AGENT_WALLET_WARNING });
    expect(s.out).toContain(AGENT_WALLET_WARNING);
    expect(String(a.next)).toContain("degenly.app/bot");
    expect(String(a.next)).toContain("Pair agent");
    // DGAJ15 fix 1: no live trade command yet -> setup must not steer the user into funding the wallet
    expect(a.liveTrading).toBe(LIVE_NOT_AVAILABLE);
    expect(String(a.next)).toContain(LIVE_NOT_AVAILABLE);
    expect(String(a.next)).not.toMatch(/send sol/i);
    expect(s.out).not.toMatch(/send sol/i);
    const d = decodeAgentPairingCode(String(a.pairingCode));
    expect(d?.message.startsWith(`Degenly (degenly.app): pair this wallet as an AI agent of ${OWNER}.\ndegenly-agent-pair-v1:${String(a.address)}|${OWNER}|`)).toBe(true);
    const key = await webcrypto.subtle.importKey("raw", base58Decode(String(a.address)) ?? new Uint8Array(0), { name: "Ed25519" }, false, ["verify"]);
    expect(await webcrypto.subtle.verify({ name: "Ed25519" }, key, d?.signature ?? new Uint8Array(0), new TextEncoder().encode(d?.message ?? ""))).toBe(true);
    // human output too
    const r2 = rig();
    const h = await r2.cli(["setup", "--owner", OWNER]);
    expect(h.code).toBe(0);
    expect(h.out).toContain(AGENT_WALLET_WARNING);
    expect(h.out).toContain("LIVE");
    expect(h.out).toContain(LIVE_NOT_AVAILABLE);
    expect(h.out).not.toMatch(/send sol/i);
    // no network at setup
    expect(r.server.calls).toHaveLength(0);
  });

  it("second setup → WALLET_EXISTS, file bytes unchanged; pair re-issues a code for the same wallet", async () => {
    const r = rig();
    const first = JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out) as Record<string, unknown>;
    const bytes = readFileSync(walletPath(r.home));
    const again = await r.cli(["setup", "--owner", OWNER, "--json"]);
    expect(JSON.parse(again.out)).toMatchObject({ ok: false, mode: "live", error: "WALLET_EXISTS", address: first.address });
    expect(again.code).not.toBe(0);
    expect(readFileSync(walletPath(r.home)).equals(bytes)).toBe(true);
    const p = JSON.parse((await r.cli(["pair", "--owner", OWNER, "--json"])).out) as Record<string, unknown>;
    expect(p).toMatchObject({ ok: true, mode: "live", address: first.address, warning: AGENT_WALLET_WARNING });
    expect(p.pairingCode).not.toBe(first.pairingCode);
    expect(p.liveTrading).toBe(LIVE_NOT_AVAILABLE);
    expect(String(p.next)).not.toMatch(/send sol/i);
    expect(readFileSync(walletPath(r.home)).equals(bytes)).toBe(true);
  });

  it("bad / missing owner → BAD_OWNER, no wallet file", async () => {
    for (const argv of [["setup", "--json"], ["setup", "--owner", "bonk", "--json"], ["setup", "--owner", "--json"]]) {
      const r = rig();
      const out = await r.cli(argv);
      expect(JSON.parse(out.out), argv.join(" ")).toMatchObject({ ok: false, mode: "live", error: "BAD_OWNER" });
      expect(existsSync(walletPath(r.home))).toBe(false);
    }
  });

  it("corrupt wallet file → WALLET_CORRUPT on pair / whoami; file untouched", async () => {
    const r = rig();
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    writeFileSync(walletPath(r.home), "{broken");
    expect(JSON.parse((await r.cli(["pair", "--owner", OWNER, "--json"])).out)).toMatchObject({ ok: false, error: "WALLET_CORRUPT" });
    expect(JSON.parse((await r.cli(["whoami", "--json"])).out)).toMatchObject({ ok: false, error: "WALLET_CORRUPT" });
    expect(JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out)).toMatchObject({ ok: false, error: "WALLET_EXISTS" });
    expect(readFileSync(walletPath(r.home), "utf8")).toBe("{broken");
  });
});

describe("DGAJ15 CLI: login", () => {
  it("never takes the key as an argument (shell history); stdin not even read", async () => {
    for (const argv of [["login", API_KEY, "--json"], ["login", "--key", API_KEY, "--json"], [`--key=${API_KEY}`, "login", "--json"], ["login", `--key=${API_KEY}`, "--json"]]) {
      const r = rig({ stdin: API_KEY });
      await r.cli(["setup", "--owner", OWNER, "--json"]);
      const out = await r.cli(argv);
      const a = JSON.parse(out.out) as Record<string, unknown>;
      expect(a, argv.join(" ")).toMatchObject({ ok: false, mode: "live", error: "KEY_ARG_REFUSED" });
      expect(out.out).not.toContain(API_KEY);
      expect(out.code).toBe(2);
      expect(existsSync(join(r.home, ".degenly", CREDENTIALS_FILE_NAME))).toBe(false);
      expect(r.stdinReads()).toBe(0);
    }
  });

  it("stdin → credentials.json (0600 on POSIX); the key is never printed; empty stdin → NO_KEY_INPUT", async () => {
    const r = rig({ stdin: `  ${API_KEY}\n` });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    const out = await r.cli(["login", "--json"]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out)).toMatchObject({ ok: true, mode: "live", keyPrefix: API_KEY.slice(0, 12) });
    expect(out.out).not.toContain(API_KEY);
    expect(loadCredentials(r.home)).toEqual({ ok: true, apiKey: API_KEY });
    if (POSIX) expect(statSync(join(r.home, ".degenly", CREDENTIALS_FILE_NAME)).mode & 0o777).toBe(0o600);
    const e = rig({ stdin: "   \n" });
    await e.cli(["setup", "--owner", OWNER, "--json"]);
    const empty = await e.cli(["login", "--json"]);
    expect(JSON.parse(empty.out)).toMatchObject({ ok: false, mode: "live", error: "NO_KEY_INPUT" });
    expect(empty.code).not.toBe(0);
  });

  it("--key-file <path>; malformed key → KEY_FORMAT (not echoed); no wallet → NO_WALLET", async () => {
    const r = rig();
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    const f = join(mkdtempSync(join(tmpdir(), "dgaj15-kf-")), "key.txt");
    writeFileSync(f, `${API_KEY}\n`);
    expect(JSON.parse((await r.cli(["login", "--key-file", f, "--json"])).out)).toMatchObject({ ok: true, mode: "live" });
    expect(r.stdinReads()).toBe(0);
    const bad = rig({ stdin: "dgk_short-secret-text" });
    await bad.cli(["setup", "--owner", OWNER, "--json"]);
    const b = await bad.cli(["login", "--json"]);
    expect(JSON.parse(b.out)).toMatchObject({ ok: false, error: "KEY_FORMAT" });
    expect(b.out).not.toContain("short-secret-text");
    const none = rig({ stdin: API_KEY });
    expect(JSON.parse((await none.cli(["login", "--json"])).out)).toMatchObject({ ok: false, error: "NO_WALLET" });
    expect(JSON.parse((await none.cli(["login", "--key-file", join(tmpdir(), "does-not-exist-dgaj15"), "--json"])).out)).toMatchObject({ ok: false });
  });
});

describe("DGAJ15 CLI: whoami", () => {
  it("no wallet → NO_WALLET; wallet without login → NOT_LOGGED_IN; both without network", async () => {
    const r = rig();
    const a = await r.cli(["whoami", "--json"]);
    expect(JSON.parse(a.out)).toMatchObject({ ok: false, mode: "live", error: "NO_WALLET" });
    expect(a.code).not.toBe(0);
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    expect(JSON.parse((await r.cli(["whoami", "--json"])).out)).toMatchObject({ ok: false, mode: "live", error: "NOT_LOGGED_IN" });
    expect(r.server.calls).toHaveLength(0);
  });

  it("logged in → one signed GET /v1/whoami the server accepts; wallet matches", async () => {
    const r = rig({ stdin: API_KEY });
    const s = JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out) as Record<string, unknown>;
    await r.cli(["login", "--json"]);
    const w = await r.cli(["whoami", "--json"]);
    expect(w.code).toBe(0);
    expect(JSON.parse(w.out)).toMatchObject({ ok: true, mode: "live", wallet: s.address, keyId: "k1" });
    expect(r.server.calls).toHaveLength(1);
    expect(r.server.calls[0]?.url).toBe("https://degenly.app/v1/whoami");
    expect(r.server.calls[0]?.method).toBe("GET");
    expect(r.server.verified).toEqual([true]);
  });

  it("server says another wallet → KEY_WALLET_MISMATCH", async () => {
    const r = rig({ stdin: API_KEY, answer: () => ({ status: 200, body: { ok: true, wallet: OWNER, keyId: "k1" } }) });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    await r.cli(["login", "--json"]);
    expect(JSON.parse((await r.cli(["whoami", "--json"])).out)).toMatchObject({ ok: false, mode: "live", error: "KEY_WALLET_MISMATCH" });
  });
});

describe("DGAJ15 leak capture: the private key never leaves the wallet file", () => {
  it("setup + login + whoami + a signed GET: no form of the private key in any request or any output", async () => {
    const printed: string[] = [];
    const grab = (chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(grab);
    vi.spyOn(process.stderr, "write").mockImplementation(grab);
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));

    const r = rig({ stdin: API_KEY });
    const outs: string[] = [];
    for (const argv of [["setup", "--owner", OWNER, "--json"], ["setup", "--owner", OWNER], ["pair", "--owner", OWNER, "--json"], ["login", "--json"], ["whoami", "--json"], ["whoami"]]) {
      outs.push((await r.cli(argv)).out);
    }
    const w = loadWallet(r.home);
    if (!w.ok) throw new Error("no wallet");
    await createLiveClient({ fetch: r.server.fetch, base: DEFAULT_API_BASE, apiKey: API_KEY, signer: w.wallet, now: () => NOW }).request("GET", "/v1/data/holdings");
    expect(r.server.verified.every(Boolean)).toBe(true);
    expect(r.server.calls.length).toBeGreaterThanOrEqual(3);

    const fileText = readFileSync(walletPath(r.home), "utf8");
    const full = Uint8Array.from(JSON.parse(fileText) as number[]);
    const seed = full.slice(0, 32);
    const forms = [
      fileText.trim(),
      JSON.stringify(Array.from(full)),
      JSON.stringify(Array.from(seed)),
      Array.from(seed).join(","),
      base58Encode(seed),
      base58Encode(full),
      Buffer.from(seed).toString("hex"),
      Buffer.from(full).toString("hex"),
      Buffer.from(seed).toString("base64"),
      Buffer.from(full).toString("base64"),
      Buffer.from(seed).toString("base64url"),
      Buffer.from(full).toString("base64url"),
    ];
    const haystack = [...outs, ...printed, ...r.server.calls.map((c) => `${c.url}\n${JSON.stringify(c.headers)}\n${c.body}`)].join("\n");
    for (const f of forms) expect(haystack.includes(f), `leaked form: ${f.slice(0, 6)}…`).toBe(false);
    // hex / base64 of the seed in upper case too
    expect(haystack.includes(Buffer.from(seed).toString("hex").toUpperCase())).toBe(false);
    // the API key itself only travels in the x-degenly-key header
    expect(outs.join("\n").includes(API_KEY)).toBe(false);
    for (const c of r.server.calls) expect(c.url.includes(API_KEY) || c.body.includes(API_KEY)).toBe(false);
    // nothing written in the working directory
    expect(readdirSync(process.cwd()).some((n) => n === "agent-wallet.json" || n === CREDENTIALS_FILE_NAME)).toBe(false);
  });
});

describe("DGAJ15 package.json", () => {
  it("no install-time scripts; private; only the MCP SDK as runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { private?: boolean; scripts?: Record<string, string>; dependencies?: Record<string, string> };
    for (const s of ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"]) expect(pkg.scripts?.[s], s).toBeUndefined();
    expect(pkg.private).toBe(true);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@modelcontextprotocol/sdk"]);
  });
});

describe("DGAJ15 demo stays demo", () => {
  it("demo answers keep mode demo; live answers say mode live", async () => {
    const r = rig();
    expect(JSON.parse((await r.cli(["demo", "status", "--json"])).out)).toMatchObject({ ok: true, mode: "demo" });
    expect(JSON.parse((await r.cli(["whoami", "--json"])).out)).toMatchObject({ mode: "live" });
    // without live deps (demo-only callers), the live commands keep the old answer
    expect(JSON.parse((await runCli(["setup", "--owner", OWNER, "--json"], r.ops)).out)).toMatchObject({ ok: false, error: "NOT_AVAILABLE_IN_DEMO" });
  });
});
