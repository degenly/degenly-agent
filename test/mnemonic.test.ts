/**
 * DGAJ29: the 12-word recovery phrase, checked against PUBLISHED vectors only (copied to test/fixtures/):
 *  - the official BIP39 English vectors (trezor vectors.json, passphrase "TREZOR"): entropy <-> words, seed;
 *  - SLIP-0010 ed25519 test vector 1 (chain m and m/0H);
 *  - 3 Solana vectors (words -> seed -> m/44'/501'/0'/0' -> address), made by the CEO with a separate script;
 *  - the word list = the official file (sha256).
 * No network. Temp homes only, never the real ~/.degenly.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/api.js";
import { BIP39_ENGLISH } from "../src/bip39-words.js";
import { PHRASE_SAFETY, RECOVERY_NEEDS_TERMINAL_TEXT, USAGE, createOps, runCli, type LiveDeps } from "../src/cli.js";
import { liveHint, saveCredentials } from "../src/client.js";
import { AGENT_WALLET_WARNING, RECOVERY_FILE_NAME, RECOVERY_SETUP_TEXT, WALLET_FILE_NAME, createWallet, loadRecoveryEntropy, loadWallet, recoveryPath, recoveryWords, restoreWallet, signerFromSeed, walletPath } from "../src/keys.js";
import { LIVE_TOOLS, LIVE_WHOAMI_TOOL, TOOLS, createMcpServer } from "../src/mcp.js";
import { SOLANA_PATH, entropyToSolanaSeed, entropyToWords, phraseToSeed, slip10Ed25519, splitPhrase, wordsToEntropy } from "../src/mnemonic.js";
import { base58Encode } from "../src/sign.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const BIP39 = JSON.parse(readFileSync(join(FIX, "bip39-vectors.json"), "utf8")) as { english: string[][] };
const SOLANA = JSON.parse(readFileSync(join(FIX, "solana-vectors.json"), "utf8")) as {
  vectors: { mnemonic: string; passphrase: string; path: string; bip39SeedHex: string; privateSeedHex: string; publicKeyHex: string; address: string }[];
};
const WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";
const OWNER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const NOW = 1791594000000;
const POSIX = process.platform !== "win32";
const ALL_COUNTS = [12, 15, 18, 21, 24];

const tmpHome = () => mkdtempSync(join(tmpdir(), "dgaj29-"));

describe("DGAJ29 BIP39 word list", () => {
  it("2048 words; sha256 of the words joined with \\n (+ final \\n, as the official file) is the official hash", () => {
    expect(BIP39_ENGLISH).toHaveLength(2048);
    expect(createHash("sha256").update(`${BIP39_ENGLISH.join("\n")}\n`).digest("hex")).toBe(WORDLIST_SHA256);
    expect(new Set(BIP39_ENGLISH).size).toBe(2048);
    expect(BIP39_ENGLISH[0]).toBe("abandon");
    expect(BIP39_ENGLISH[2047]).toBe("zoo");
  });
});

describe("DGAJ29 BIP39 official vectors (all of them)", () => {
  it(`entropy -> words, words -> entropy, words + "TREZOR" -> seed: ${BIP39.english.length} vectors`, () => {
    expect(BIP39.english.length).toBe(24);
    for (const [entropyHex = "", phrase = "", seedHex = ""] of BIP39.english) {
      const entropy = Buffer.from(entropyHex, "hex");
      expect(entropyToWords(entropy).join(" "), entropyHex).toBe(phrase);
      const back = wordsToEntropy(splitPhrase(phrase), ALL_COUNTS);
      expect(back.ok && back.entropy.toString("hex"), phrase).toBe(entropyHex);
      expect(phraseToSeed(phrase, "TREZOR").toString("hex"), phrase).toBe(seedHex);
    }
  });

  it("the agent wallet accepts exactly 12 words; a wrong checksum / an unknown word is refused, nothing guessed", () => {
    const twelve = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(wordsToEntropy(splitPhrase(twelve)).ok).toBe(true);
    // official 24-word vector: valid BIP39, but not a 12-word agent phrase
    const v24 = BIP39.english.find((v) => (v[1] ?? "").split(" ").length === 24)?.[1] ?? "";
    expect(wordsToEntropy(splitPhrase(v24))).toEqual({ ok: false, error: "PHRASE_WORD_COUNT" });
    expect(wordsToEntropy(splitPhrase(twelve).slice(0, 11))).toEqual({ ok: false, error: "PHRASE_WORD_COUNT" });
    expect(wordsToEntropy([...splitPhrase(twelve), "abandon"])).toEqual({ ok: false, error: "PHRASE_WORD_COUNT" });
    // last word changed to another valid word -> checksum fails
    expect(wordsToEntropy(splitPhrase(twelve.replace(/yellow$/, "abandon")))).toEqual({ ok: false, error: "PHRASE_CHECKSUM" });
    expect(wordsToEntropy(splitPhrase("abandon ".repeat(12).trim()))).toEqual({ ok: false, error: "PHRASE_CHECKSUM" });
    // a typo is not corrected
    expect(wordsToEntropy(splitPhrase(twelve.replace("winner", "winer")))).toEqual({ ok: false, error: "PHRASE_UNKNOWN_WORD" });
    // case and spacing only are normalized
    expect(wordsToEntropy(splitPhrase(`  ${twelve.toUpperCase().replace(/ /g, "  \t")}\n`)).ok).toBe(true);
  });
});

describe("DGAJ29 SLIP-0010 ed25519 test vector 1", () => {
  it("chain m and m/0H", () => {
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const m = slip10Ed25519(seed, "m");
    expect(m.chainCode.toString("hex")).toBe("90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb");
    expect(m.key.toString("hex")).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
    const pubM = base58Encode(Buffer.from("a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed", "hex"));
    expect(signerFromSeed(m.key).address).toBe(pubM);
    const h = slip10Ed25519(seed, "m/0'");
    expect(h.chainCode.toString("hex")).toBe("8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69");
    expect(h.key.toString("hex")).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
    expect(signerFromSeed(h.key).address).toBe(base58Encode(Buffer.from("8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c", "hex")));
    // ed25519 has no normal (non-hardened) derivation
    expect(() => slip10Ed25519(seed, "m/0")).toThrow();
  });
});

describe("DGAJ29 Solana vectors (m/44'/501'/0'/0', Phantom / Solflare default)", () => {
  it("words -> BIP39 seed -> private seed -> public key -> address, 3 vectors", () => {
    expect(SOLANA.vectors).toHaveLength(3);
    expect(SOLANA_PATH).toBe("m/44'/501'/0'/0'");
    for (const v of SOLANA.vectors) {
      expect(v.path).toBe(SOLANA_PATH);
      const seed = phraseToSeed(v.mnemonic, v.passphrase);
      expect(seed.toString("hex")).toBe(v.bip39SeedHex);
      const { key } = slip10Ed25519(seed, v.path);
      expect(key.toString("hex")).toBe(v.privateSeedHex);
      const signer = signerFromSeed(key);
      expect(signer.address).toBe(v.address);
      expect(signer.address).toBe(base58Encode(Buffer.from(v.publicKeyHex, "hex")));
      // the entropy path the wallet uses gives the same key
      const e = wordsToEntropy(splitPhrase(v.mnemonic));
      if (!e.ok) throw new Error(e.error);
      expect(entropyToSolanaSeed(e.entropy).toString("hex")).toBe(v.privateSeedHex);
    }
  });

  it("restoreWallet from a vector's entropy writes the vector's address; agent-wallet.json is still 64 bytes", () => {
    const v = SOLANA.vectors[0];
    if (!v) throw new Error("no vector");
    const home = tmpHome();
    const e = wordsToEntropy(splitPhrase(v.mnemonic));
    if (!e.ok) throw new Error(e.error);
    const r = restoreWallet(home, e.entropy);
    expect(r.ok && r.wallet.address).toBe(v.address);
    const arr = JSON.parse(readFileSync(walletPath(home), "utf8")) as number[];
    expect(arr).toHaveLength(64);
    expect(Buffer.from(arr.slice(0, 32)).toString("hex")).toBe(v.privateSeedHex);
    expect(Buffer.from(arr.slice(32)).toString("hex")).toBe(v.publicKeyHex);
  });
});

// ---- CLI rig -------------------------------------------------------------------------------------

function rig(o: { stdin?: string; interactive?: boolean; home?: string } = {}) {
  const home = o.home ?? tmpHome();
  const calls: { url: string; headers: string; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const h = init?.headers;
    calls.push({ url: String(url), headers: JSON.stringify(h ?? {}), body: typeof init?.body === "string" ? init.body : String(init?.body ?? "") });
    const w = loadWallet(home);
    return new Response(JSON.stringify({ ok: true, wallet: w.ok ? w.wallet.address : "", keyId: "k1", serverTs: NOW }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let stdinReads = 0;
  const live: LiveDeps = {
    home,
    env: {},
    fetch,
    now: () => NOW,
    readStdin: async () => {
      stdinReads++;
      return o.stdin ?? "";
    },
    ...(o.interactive !== undefined ? { interactive: () => o.interactive === true } : {}),
  };
  const ops = createOps({ home, fetch, now: () => NOW });
  return { home, live, ops, calls, cli: (argv: string[]) => runCli(argv, ops, live), stdinReads: () => stdinReads };
}

const PHRASE_LINE = /^\s*\d+\. ([a-z]+)$/;
const wordsOf = (out: string) => out.split("\n").map((l) => PHRASE_LINE.exec(l)?.[1]).filter((w): w is string => w !== undefined);

afterEach(() => vi.restoreAllMocks());

describe("DGAJ29 createWallet + recovery.json", () => {
  it("setup writes recovery.json ({v:1, entropyHex}); its 12 words open the wallet's address; agent-wallet.json format unchanged", () => {
    const home = tmpHome();
    const c = createWallet(home);
    if (!c.ok) throw new Error(c.error);
    const rec = JSON.parse(readFileSync(recoveryPath(home), "utf8")) as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(["entropyHex", "v"]);
    expect(rec.v).toBe(1);
    expect(String(rec.entropyHex)).toMatch(/^[0-9a-f]{32}$/);
    const words = entropyToWords(Buffer.from(String(rec.entropyHex), "hex"));
    expect(words).toHaveLength(12);
    // from the words alone (as a human would type them into Phantom): BIP39 seed -> m/44'/501'/0'/0'
    const { key } = slip10Ed25519(phraseToSeed(words.join(" ")), SOLANA_PATH);
    expect(signerFromSeed(key).address).toBe(c.wallet.address);
    const arr = JSON.parse(readFileSync(walletPath(home), "utf8")) as unknown[];
    expect(arr).toHaveLength(64);
    expect(readdirSync(join(home, ".degenly")).sort()).toEqual([RECOVERY_FILE_NAME, WALLET_FILE_NAME].sort());
    const rw = recoveryWords(home);
    expect(rw.ok && rw.words).toEqual(words);
    expect(rw.ok && rw.address).toBe(c.wallet.address);
  });

  it.skipIf(!POSIX)("POSIX: recovery.json 0600", () => {
    const home = tmpHome();
    createWallet(home);
    expect(statSync(recoveryPath(home)).mode & 0o777).toBe(0o600);
  });

  it("two wallets never share entropy; a recovery.json left alone (no wallet) is never overwritten", () => {
    const a = tmpHome();
    const b = tmpHome();
    createWallet(a);
    createWallet(b);
    expect(readFileSync(recoveryPath(a), "utf8")).not.toBe(readFileSync(recoveryPath(b), "utf8"));
    const lone = tmpHome();
    mkdirSync(join(lone, ".degenly"), { recursive: true });
    writeFileSync(recoveryPath(lone), '{"v":1,"entropyHex":"00000000000000000000000000000000"}');
    expect(createWallet(lone)).toEqual({ ok: false, error: "RECOVERY_EXISTS" });
    expect(readFileSync(recoveryPath(lone), "utf8")).toBe('{"v":1,"entropyHex":"00000000000000000000000000000000"}');
    expect(existsSync(walletPath(lone))).toBe(false);
  });

  it("an OLD wallet (no recovery.json) loads, signs, and is never touched; recovery-phrase says NO_RECOVERY_PHRASE", async () => {
    const r = rig({ interactive: true });
    // a pre-DGAJ29 wallet file: random seed, no recovery.json
    const seed = Buffer.alloc(32, 7);
    const signer = signerFromSeed(seed);
    mkdirSync(join(r.home, ".degenly"), { recursive: true });
    const { createPublicKey, createPrivateKey } = await import("node:crypto");
    const der = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
    const content = JSON.stringify([...seed, ...der.subarray(der.length - 32)]);
    writeFileSync(walletPath(r.home), content);
    const l = loadWallet(r.home);
    expect(l.ok && l.wallet.address).toBe(signer.address);
    const out = await r.cli(["recovery-phrase"]);
    expect(out.code).not.toBe(0);
    expect(out.out).toContain("NO_RECOVERY_PHRASE");
    expect(out.out).toContain("This agent wallet was created before recovery phrases existed. Back up ~/.degenly/agent-wallet.json, or withdraw and run setup again.");
    expect(loadRecoveryEntropy(r.home)).toEqual({ ok: false, error: "NO_RECOVERY_PHRASE" });
    // setup and recover never touch it
    expect(JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out)).toMatchObject({ ok: false, error: "WALLET_EXISTS" });
    expect(readFileSync(walletPath(r.home), "utf8")).toBe(content);
    expect(existsSync(recoveryPath(r.home))).toBe(false);
  });
});

describe("DGAJ29 degenly recovery-phrase: words only in an interactive terminal", () => {
  it("interactive terminal (stdout + stdin TTY): 12 numbered words + the safety text; they open the wallet's address", async () => {
    const r = rig({ interactive: true });
    const s = JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out) as Record<string, unknown>;
    const out = await r.cli(["recovery-phrase"]);
    expect(out.code).toBe(0);
    const words = wordsOf(out.out);
    expect(words).toHaveLength(12);
    expect(out.out).toContain(PHRASE_SAFETY);
    expect(out.out).toContain(String(s.address));
    const { key } = slip10Ed25519(phraseToSeed(words.join(" ")), SOLANA_PATH);
    expect(signerFromSeed(key).address).toBe(s.address);
    expect(r.calls).toHaveLength(0);
  });

  it("not a TTY (default / interactive false), --json, or an extra word → RECOVERY_NEEDS_TERMINAL, no word printed", async () => {
    for (const [interactive, argv] of [
      [undefined, ["recovery-phrase"]],
      [false, ["recovery-phrase"]],
      [false, ["recovery-phrase", "--json"]],
      [true, ["recovery-phrase", "--json"]],
      [true, ["recovery-phrase", "now"]],
    ] as const) {
      const r = rig(interactive === undefined ? {} : { interactive });
      await r.cli(["setup", "--owner", OWNER, "--json"]);
      const e = loadRecoveryEntropy(r.home);
      if (!e.ok) throw new Error(e.error);
      const words = entropyToWords(e.entropy);
      const out = await r.cli([...argv]);
      expect(out.code, argv.join(" ")).not.toBe(0);
      expect(out.out).toContain("RECOVERY_NEEDS_TERMINAL");
      expect(out.out).toContain(RECOVERY_NEEDS_TERMINAL_TEXT);
      expect(liveHint("RECOVERY_NEEDS_TERMINAL")).toBe("Run this yourself in your own terminal. It is never shown to an agent.");
      expect(wordsOf(out.out)).toEqual([]);
      for (let i = 0; i + 1 < words.length; i++) expect(out.out).not.toContain(`${words[i]} ${words[i + 1]}`);
      expect(out.out).not.toContain(words.join(" "));
      expect(out.out).not.toContain(e.entropy.toString("hex"));
    }
  });

  it("a recovery.json that does not open the wallet's address → RECOVERY_MISMATCH, nothing shown", async () => {
    const r = rig({ interactive: true });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    writeFileSync(recoveryPath(r.home), `{"v":1,"entropyHex":"${"7f".repeat(16)}"}`);
    const out = await r.cli(["recovery-phrase"]);
    expect(out.out).toContain("RECOVERY_MISMATCH");
    expect(wordsOf(out.out)).toEqual([]);
    expect(out.out).not.toContain("legal winner");
  });
});

describe("DGAJ29 degenly recover", () => {
  const V = SOLANA.vectors[1];
  if (!V) throw new Error("no vector");

  it("stdin → wallet + recovery.json; output = the address only (no word, no entropy)", async () => {
    const r = rig({ stdin: `${V.mnemonic}\n` });
    const out = await r.cli(["recover", "--json"]);
    expect(out.code).toBe(0);
    const a = JSON.parse(out.out) as Record<string, unknown>;
    expect(a).toMatchObject({ ok: true, mode: "live", address: V.address });
    for (const w of V.mnemonic.split(" ")) expect(out.out.toLowerCase(), w).not.toContain(w);
    expect(loadWallet(r.home).ok).toBe(true);
    const e = loadRecoveryEntropy(r.home);
    expect(e.ok && entropyToWords(e.entropy).join(" ")).toBe(V.mnemonic);
    expect(out.out).not.toContain(e.ok ? e.entropy.toString("hex") : "x");
    expect(r.calls).toHaveLength(0);
  });

  it("--phrase-file <path>; stdin not read", async () => {
    const r = rig({ stdin: "should not be read" });
    const f = join(mkdtempSync(join(tmpdir(), "dgaj29-pf-")), "phrase.txt");
    writeFileSync(f, V.mnemonic);
    const out = await r.cli(["recover", "--phrase-file", f, "--json"]);
    expect(JSON.parse(out.out)).toMatchObject({ ok: true, address: V.address });
    expect(r.stdinReads()).toBe(0);
  });

  it("never over an existing wallet (WALLET_EXISTS, bytes unchanged, stdin not read)", async () => {
    const r = rig({ stdin: V.mnemonic });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    const before = readFileSync(walletPath(r.home));
    const rec = readFileSync(recoveryPath(r.home));
    const out = await r.cli(["recover", "--json"]);
    expect(JSON.parse(out.out)).toMatchObject({ ok: false, error: "WALLET_EXISTS" });
    expect(readFileSync(walletPath(r.home)).equals(before)).toBe(true);
    expect(readFileSync(recoveryPath(r.home)).equals(rec)).toBe(true);
    expect(r.stdinReads()).toBe(0);
    // a corrupt wallet file is also never replaced
    writeFileSync(walletPath(r.home), "{broken");
    expect(JSON.parse((await r.cli(["recover", "--json"])).out)).toMatchObject({ ok: false, error: "WALLET_EXISTS" });
    expect(readFileSync(walletPath(r.home), "utf8")).toBe("{broken");
  });

  it("the phrase as an argument / flag is refused (PHRASE_ARG_REFUSED), never echoed, stdin not read", async () => {
    for (const argv of [["recover", ...V.mnemonic.split(" ")], ["recover", "--phrase", V.mnemonic], [`--mnemonic=${V.mnemonic}`, "recover"], ["recover", "--words", "legal"], ["setup", "--seed", "legal"]]) {
      const r = rig({ stdin: V.mnemonic });
      const out = await r.cli([...argv, "--json"]);
      expect(JSON.parse(out.out), argv.join(" ")).toMatchObject({ ok: false, error: "PHRASE_ARG_REFUSED" });
      expect(out.code).toBe(2);
      expect(out.out).not.toContain("legal");
      expect(r.stdinReads()).toBe(0);
      expect(existsSync(walletPath(r.home))).toBe(false);
    }
  });

  it("bad input: empty / 11 words / checksum / unknown word → its code, no wallet, the input never echoed", async () => {
    const twelve = V.mnemonic.split(" ");
    for (const [stdin, code] of [
      ["", "NO_PHRASE_INPUT"],
      [twelve.slice(0, 11).join(" "), "PHRASE_WORD_COUNT"],
      [[...twelve.slice(0, 11), twelve[0]].join(" "), "PHRASE_CHECKSUM"],
      [[...twelve.slice(0, 11), "qwertyx"].join(" "), "PHRASE_UNKNOWN_WORD"],
    ] as const) {
      const r = rig({ stdin });
      const out = await r.cli(["recover", "--json"]);
      expect(JSON.parse(out.out), code).toMatchObject({ ok: false, error: code });
      expect(out.out).not.toContain("qwertyx");
      expect(out.out).not.toContain(twelve.slice(0, 3).join(" "));
      expect(existsSync(walletPath(r.home))).toBe(false);
      expect(existsSync(recoveryPath(r.home))).toBe(false);
    }
  });
});

describe("DGAJ29 setup output: no words, the recovery sentence word for word", () => {
  it("--json and human: RECOVERY_SETUP_TEXT + AGENT_WALLET_WARNING; no word / entropy of recovery.json", async () => {
    expect(RECOVERY_SETUP_TEXT).toBe("Recovery phrase: run `degenly recovery-phrase` yourself in your own terminal and write the 12 words down. Degenly never sees or stores them.");
    for (const json of [true, false]) {
      const r = rig({ interactive: true });
      const out = await r.cli(["setup", "--owner", OWNER, ...(json ? ["--json"] : [])]);
      expect(out.code).toBe(0);
      expect(out.out).toContain(RECOVERY_SETUP_TEXT);
      expect(out.out).toContain(AGENT_WALLET_WARNING);
      if (json) expect(JSON.parse(out.out)).toMatchObject({ recovery: RECOVERY_SETUP_TEXT, warning: AGENT_WALLET_WARNING });
      const e = loadRecoveryEntropy(r.home);
      if (!e.ok) throw new Error(e.error);
      const words = entropyToWords(e.entropy);
      expect(wordsOf(out.out)).toEqual([]);
      expect(out.out).not.toContain(words.slice(0, 2).join(" "));
      expect(out.out).not.toContain(e.entropy.toString("hex"));
    }
  });
});

describe("DGAJ29 leak capture: words / entropy / seed never in a /v1 request, a log, an error or --json", () => {
  it("setup, pair, login, whoami, recovery-phrase refusals, recover refusals: fetch spy bodies + headers, stdout / console", async () => {
    const printed: string[] = [];
    const grab = (chunk: unknown): boolean => {
      printed.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(grab);
    vi.spyOn(process.stderr, "write").mockImplementation(grab);
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));

    const API_KEY = `dgk_${base58Encode(new Uint8Array(32).fill(9))}`;
    const r = rig({ stdin: API_KEY });
    const outs: string[] = [];
    for (const argv of [["setup", "--owner", OWNER, "--json"], ["setup", "--owner", OWNER], ["pair", "--owner", OWNER, "--json"], ["login", "--json"], ["whoami", "--json"], ["whoami"], ["recovery-phrase"], ["recovery-phrase", "--json"], ["recover", "--json"], ["recover"], ["help"]]) {
      outs.push((await r.cli(argv)).out);
    }
    expect(r.calls.length).toBeGreaterThanOrEqual(2);
    expect(r.calls.every((c) => c.url.startsWith("https://degenly.app/v1/"))).toBe(true);
    const e = loadRecoveryEntropy(r.home);
    if (!e.ok) throw new Error(e.error);
    const words = entropyToWords(e.entropy);
    const seed = phraseToSeed(words.join(" "));
    const forms = [
      words.join(" "),
      words.slice(0, 3).join(" "),
      words.slice(-3).join(" "),
      JSON.stringify(words),
      e.entropy.toString("hex"),
      e.entropy.toString("hex").toUpperCase(),
      e.entropy.toString("base64"),
      seed.toString("hex"),
      seed.toString("base64"),
      readFileSync(recoveryPath(r.home), "utf8"),
    ];
    const haystack = [...outs, ...printed, ...r.calls.map((c) => `${c.url}\n${c.headers}\n${c.body}`)].join("\n");
    for (const f of forms) expect(haystack.includes(f), `leaked form: ${f.slice(0, 4)}…`).toBe(false);
  });
});

describe("DGAJ29 MCP: no tool reads or returns the recovery phrase", () => {
  it("no tool name / description about a phrase, mnemonic, seed, recovery or export; no tool answer holds recovery.json", async () => {
    const all = [...TOOLS, LIVE_WHOAMI_TOOL, ...LIVE_TOOLS];
    for (const t of all) expect(`${t.name} ${t.description ?? ""}`, t.name).not.toMatch(/recover|phrase|mnemonic|seed|export|backup/i);

    const r = rig({ interactive: true });
    await r.cli(["setup", "--owner", OWNER, "--json"]);
    saveCredentials(r.home, `dgk_${base58Encode(new Uint8Array(32).fill(9))}`);
    const e = loadRecoveryEntropy(r.home);
    if (!e.ok) throw new Error(e.error);
    const words = entropyToWords(e.entropy);
    const server = createMcpServer(r.ops, r.live);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const texts: string[] = [JSON.stringify(await client.listTools())];
    for (const name of [...listed, "degenly_recovery_phrase", "degenly_live_recovery_phrase", "recovery-phrase"]) {
      const res = await client.callTool({ name, arguments: { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", side: "buy", amount: "0.01", sol: "0.01", query: "bonk" } }).catch((err: unknown) => ({ content: [{ type: "text", text: String(err) }] }));
      texts.push(JSON.stringify(res));
    }
    await client.close();
    const hay = texts.join("\n");
    expect(hay.includes(words.join(" "))).toBe(false);
    expect(hay.includes(words.slice(0, 2).join(" "))).toBe(false);
    expect(hay.includes(e.entropy.toString("hex"))).toBe(false);
    expect(hay.includes("entropyHex")).toBe(false);
  });
});

describe("DGAJ29 USAGE", () => {
  it("lists both commands and the two safety sentences", () => {
    expect(USAGE).toContain("degenly recovery-phrase");
    expect(USAGE).toContain("degenly recover [--phrase-file <path>]");
    expect(USAGE).toContain("Degenly never sees or stores your recovery phrase");
    expect(USAGE).toContain("anyone with the phrase can take the agent wallet's funds; never paste it into a chat or give it to an agent".replace(/^a/, "A"));
  });
});
