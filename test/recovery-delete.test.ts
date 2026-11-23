/**
 * DGAJ34 (DGAJ31 G-1): `degenly recovery-phrase` asks the human to type DELETE after the words; only an exact DELETE
 * removes ~/.degenly/recovery.json (nothing else). The scope sentence sits under the words, in README and SKILL.md.
 * No network. Temp homes only, never the real ~/.degenly. No word / entropy is ever printed by the tests.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verify, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/api.js";
import {
  PHRASE_SAFETY,
  PHRASE_SCOPE_WARNING,
  RECOVERY_DELETE_QUESTION,
  RECOVERY_DELETE_REMINDER,
  RECOVERY_GONE_TEXT,
  RECOVERY_KEPT_TEXT,
  createOps,
  runCli,
  type LiveDeps,
} from "../src/cli.js";
import { AGENT_WALLET_WARNING, RECOVERY_FILE_NAME, WALLET_FILE_NAME, createWallet, deleteRecoveryFile, loadRecoveryEntropy, loadWallet, recoveryPath, walletPath } from "../src/keys.js";
import { entropyToWords } from "../src/mnemonic.js";
import { base58Decode } from "../src/sign.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SKILL = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const OWNER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const NOW = 1791594000000;
const PHRASE_LINE = /^\s*\d+\. ([a-z]+)$/;
const wordsOf = (out: string) => out.split("\n").map((l) => PHRASE_LINE.exec(l)?.[1]).filter((w): w is string => w !== undefined);

/** answer: the typed line; "EOF" = the prompt resolves "" as on Ctrl+D; "THROW" = the prompt fails. */
function rig(o: { interactive?: boolean; answer?: string | "EOF" | "THROW"; noPrompt?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dgaj34-"));
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: false, error: "NOT_FOUND" }), { status: 404 });
  };
  const prompts: string[] = [];
  const live: LiveDeps = {
    home,
    env: {},
    fetch,
    now: () => NOW,
    readStdin: async () => "",
    ...(o.interactive !== undefined ? { interactive: () => o.interactive === true } : {}),
    ...(o.noPrompt === true
      ? {}
      : {
          promptLine: async (q: string) => {
            prompts.push(q);
            if (o.answer === "THROW") throw new Error("closed");
            if (o.answer === "EOF" || o.answer === undefined) return "";
            return o.answer;
          },
        }),
  };
  const ops = createOps({ home, fetch, now: () => NOW });
  return { home, calls, prompts, cli: (argv: string[]) => runCli(argv, ops, live) };
}

async function setup(r: ReturnType<typeof rig>): Promise<{ address: string; words: string[] }> {
  const s = JSON.parse((await r.cli(["setup", "--owner", OWNER, "--json"])).out) as { address: string };
  const e = loadRecoveryEntropy(r.home);
  if (!e.ok) throw new Error(e.error);
  return { address: s.address, words: entropyToWords(e.entropy) };
}

describe("DGAJ34 recovery-phrase: the DELETE step", () => {
  it("TTY + DELETE (spaces trimmed): recovery.json gone, agent-wallet.json stays, same address, signing still works", async () => {
    for (const answer of ["DELETE", "  DELETE \n"]) {
      const r = rig({ interactive: true, answer });
      const { address, words } = await setup(r);
      const walletBefore = readFileSync(walletPath(r.home), "utf8");
      const out = await r.cli(["recovery-phrase"]);
      expect(out.code).toBe(0);
      // the words + the scope sentence were in the prompt, then the question
      expect(r.prompts).toHaveLength(1);
      const shown = r.prompts[0] ?? "";
      expect(wordsOf(shown)).toEqual(words);
      expect(shown).toContain(PHRASE_SCOPE_WARNING);
      expect(shown.trimEnd().endsWith(RECOVERY_DELETE_QUESTION)).toBe(true);
      expect(out.out).toBe(RECOVERY_GONE_TEXT);
      expect(wordsOf(out.out)).toEqual([]);
      expect(existsSync(recoveryPath(r.home))).toBe(false);
      expect(readFileSync(walletPath(r.home), "utf8")).toBe(walletBefore);
      const w = loadWallet(r.home);
      if (!w.ok) throw new Error(w.error);
      expect(w.wallet.address).toBe(address);
      const msg = new TextEncoder().encode("dgaj34 still signs");
      const sig = w.wallet.sign(msg);
      const pub = base58Decode(address);
      if (pub === undefined) throw new Error("bad address");
      const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
      expect(verify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig)).toBe(true);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("TTY + delete / yes / empty / EOF / a prompt error → recovery.json stays (same bytes), the kept line", async () => {
    for (const answer of ["delete", "yes", "Delete", "DELETE now", "", "EOF", "THROW"] as const) {
      const r = rig({ interactive: true, answer });
      await setup(r);
      const before = readFileSync(recoveryPath(r.home), "utf8");
      const out = await r.cli(["recovery-phrase"]);
      expect(out.code, answer).toBe(0);
      expect(out.out, answer).toBe(RECOVERY_KEPT_TEXT);
      expect(readFileSync(recoveryPath(r.home), "utf8"), answer).toBe(before);
      expect(existsSync(walletPath(r.home))).toBe(true);
    }
  });

  it("not a TTY / --json: no question, no delete, no word shown (RECOVERY_NEEDS_TERMINAL)", async () => {
    for (const [interactive, argv] of [
      [undefined, ["recovery-phrase"]],
      [false, ["recovery-phrase"]],
      [false, ["recovery-phrase", "--json"]],
      [true, ["recovery-phrase", "--json"]],
    ] as const) {
      const r = rig({ ...(interactive === undefined ? {} : { interactive }), answer: "DELETE" });
      const { words } = await setup(r);
      const out = await r.cli([...argv]);
      expect(out.code).not.toBe(0);
      expect(out.out).toContain("RECOVERY_NEEDS_TERMINAL");
      expect(r.prompts).toEqual([]);
      expect(existsSync(recoveryPath(r.home))).toBe(true);
      expect(wordsOf(out.out)).toEqual([]);
      expect(out.out).not.toContain(words.slice(0, 2).join(" "));
    }
  });

  it("TTY without a prompt (promptLine absent): words + scope sentence, no question, nothing deleted", async () => {
    const r = rig({ interactive: true, noPrompt: true });
    const { words } = await setup(r);
    const out = await r.cli(["recovery-phrase"]);
    expect(out.code).toBe(0);
    expect(wordsOf(out.out)).toEqual(words);
    expect(out.out).not.toContain(RECOVERY_DELETE_QUESTION);
    expect(existsSync(recoveryPath(r.home))).toBe(true);
  });

  it("after the delete: recovery-phrase shows the information line, exit 0, no word, no question", async () => {
    const r = rig({ interactive: true, answer: "DELETE" });
    const { words } = await setup(r);
    await r.cli(["recovery-phrase"]);
    const before = r.prompts.length;
    const again = await r.cli(["recovery-phrase"]);
    expect(again.code).toBe(0);
    expect(again.out).toBe(RECOVERY_GONE_TEXT);
    expect(r.prompts).toHaveLength(before);
    expect(wordsOf(again.out)).toEqual([]);
    for (const w of words) expect(again.out.split(/\W+/)).not.toContain(w);
  });

  it("an OLD wallet (never had recovery.json) still answers NO_RECOVERY_PHRASE, not the deleted line", async () => {
    const r = rig({ interactive: true, answer: "DELETE" });
    await setup(r);
    // simulate a pre-DGAJ29 wallet: recovery.json removed by hand, no delete marker
    deleteRecoveryFile(r.home);
    writeFileSync(join(r.home, ".degenly", "recovery-deleted.json"), "{}");
    const out = await r.cli(["recovery-phrase"]);
    expect(out.code).not.toBe(0);
    expect(out.out).toContain("NO_RECOVERY_PHRASE");
  });
});

describe("DGAJ34 deleteRecoveryFile: recovery.json only", () => {
  it("other files in ~/.degenly stay byte for byte; a second call says NO_RECOVERY_PHRASE", () => {
    const home = mkdtempSync(join(tmpdir(), "dgaj34-del-"));
    const c = createWallet(home);
    if (!c.ok) throw new Error(c.error);
    const dir = join(home, ".degenly");
    const others: Record<string, string> = {
      "owner.json": `{"v":1,"owner":"${OWNER}"}`,
      "credentials.json": '{"apiKey":"dgk_test"}',
      "demo.json": "{}",
      "notes.txt": "keep me",
    };
    for (const [f, t] of Object.entries(others)) writeFileSync(join(dir, f), t);
    const wallet = readFileSync(walletPath(home), "utf8");
    expect(deleteRecoveryFile(home)).toEqual({ ok: true });
    expect(existsSync(recoveryPath(home))).toBe(false);
    expect(readFileSync(walletPath(home), "utf8")).toBe(wallet);
    for (const [f, t] of Object.entries(others)) expect(readFileSync(join(dir, f), "utf8"), f).toBe(t);
    const left = readdirSync(dir).sort();
    expect(left).toEqual([...Object.keys(others), WALLET_FILE_NAME, "recovery-deleted.json"].sort());
    expect(left).not.toContain(RECOVERY_FILE_NAME);
    // the marker holds the public address only
    expect(JSON.parse(readFileSync(join(dir, "recovery-deleted.json"), "utf8"))).toEqual({ v: 1, address: c.wallet.address });
    expect(deleteRecoveryFile(home)).toEqual({ ok: false, error: "NO_RECOVERY_PHRASE" });
    // takes no path: arity 1 (home only)
    expect(deleteRecoveryFile.length).toBe(1);
  });
});

describe("DGAJ34 recover: rebuilds recovery.json + the delete reminder", () => {
  it("recover writes recovery.json again and its output carries the reminder; a later DELETE removes it", async () => {
    const r = rig({ interactive: true, answer: "DELETE" });
    const { address, words } = await setup(r);
    await r.cli(["recovery-phrase"]);
    expect(existsSync(recoveryPath(r.home))).toBe(false);
    // new computer: same words
    const r2 = rig({ interactive: true, answer: "DELETE" });
    const f = join(mkdtempSync(join(tmpdir(), "dgaj34-pf-")), "phrase.txt");
    writeFileSync(f, words.join(" "));
    const out = await r2.cli(["recover", "--phrase-file", f, "--json"]);
    const a = JSON.parse(out.out) as Record<string, unknown>;
    expect(a).toMatchObject({ ok: true, address, recoveryReminder: RECOVERY_DELETE_REMINDER });
    const human = await rig().cli(["recover", "--phrase-file", f]);
    expect(human.out).toContain(RECOVERY_DELETE_REMINDER);
    for (const w of words) expect(out.out.split(/\W+/)).not.toContain(w);
    expect(existsSync(recoveryPath(r2.home))).toBe(true);
    expect((await r2.cli(["recovery-phrase"])).out).toBe(RECOVERY_GONE_TEXT);
    expect(existsSync(recoveryPath(r2.home))).toBe(false);
  });
});

describe("DGAJ34 the scope sentence: 3 places, byte for byte", () => {
  it("recovery-phrase output (right under the words), README recovery section, SKILL.md", async () => {
    expect(PHRASE_SCOPE_WARNING).toBe(
      "Use this phrase only for the agent wallet. Do not add accounts to it or use it as your main wallet: anyone who reads ~/.degenly/recovery.json gets every account of this phrase.",
    );
    const r = rig({ interactive: true, noPrompt: true });
    await setup(r);
    const lines = (await r.cli(["recovery-phrase"])).out.split("\n");
    const last = lines.map((l) => PHRASE_LINE.test(l)).lastIndexOf(true);
    expect(lines[last + 1]).toBe("");
    expect(lines[last + 2]).toBe(PHRASE_SCOPE_WARNING);
    const section = README.slice(README.indexOf("## Recovery phrase"), README.indexOf("## Add Degenly"));
    expect(section).toContain(PHRASE_SCOPE_WARNING);
    expect(section).toContain("Phantom / Solflare default");
    expect(section).toContain(`${PHRASE_SCOPE_WARNING}\n${RECOVERY_DELETE_REMINDER}`);
    expect(SKILL).toContain(PHRASE_SCOPE_WARNING);
    expect(SKILL).toContain("Never run `degenly recovery-phrase`, `degenly recover` or `degenly withdraw` through a pseudo-terminal (pty / script / expect). They are for the human only.");
    // the older sentences are unchanged
    expect(README).toContain(AGENT_WALLET_WARNING);
    expect(lines.join("\n")).toContain(PHRASE_SAFETY);
  });
});
