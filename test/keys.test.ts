/**
 * DGAJ15: the agent wallet file. Temp home only (DEGENLY_HOME-style override), never the real ~/.degenly.
 *  - `<home>/.degenly/agent-wallet.json`, POSIX 0600 (dir 0700); never in the working directory;
 *  - an existing file is NEVER overwritten (WALLET_EXISTS: a new key = lost funds);
 *  - a corrupt file is an error: not deleted, not regenerated.
 */
import { webcrypto } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_WALLET_WARNING, RECOVERY_FILE_NAME, WALLET_FILE_NAME, createWallet, loadWallet, recoveryPath, resolveHome, walletPath } from "../src/keys.js";
import { base58Decode } from "../src/sign.js";

const POSIX = process.platform !== "win32";
const tmpHome = () => mkdtempSync(join(tmpdir(), "dgaj15-keys-"));

describe("DGAJ15 keys: create", () => {
  it("writes <home>/.degenly/agent-wallet.json (Solana 64-byte array); address = base58(public key); nothing in the working directory", async () => {
    const before = readdirSync(process.cwd()).sort();
    const home = tmpHome();
    const r = createWallet(home);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const file = walletPath(home);
    expect(file).toBe(join(home, ".degenly", WALLET_FILE_NAME));
    expect(r.path).toBe(file);
    const arr: unknown = JSON.parse(readFileSync(file, "utf8"));
    expect(Array.isArray(arr) && arr.length === 64 && arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
    const bytes = Uint8Array.from(arr as number[]);
    expect(Buffer.from(bytes.slice(32)).toString("hex")).toBe(Buffer.from(base58Decode(r.wallet.address) ?? []).toString("hex"));
    // the signer works and the server's verifier accepts it
    const msg = new TextEncoder().encode("degenly-api-v1:GET|/v1/whoami|00|1");
    const key = await webcrypto.subtle.importKey("raw", base58Decode(r.wallet.address) ?? new Uint8Array(0), { name: "Ed25519" }, false, ["verify"]);
    expect(await webcrypto.subtle.verify({ name: "Ed25519" }, key, r.wallet.sign(msg), msg)).toBe(true);
    // load gives the same wallet
    const l = loadWallet(home);
    expect(l.ok && l.wallet.address === r.wallet.address).toBe(true);
    // working directory untouched
    expect(readdirSync(process.cwd()).sort()).toEqual(before);
    expect(existsSync(join(process.cwd(), WALLET_FILE_NAME))).toBe(false);
  });

  it.skipIf(!POSIX)("POSIX: file 0600, directory 0700", () => {
    const home = tmpHome();
    const r = createWallet(home);
    expect(r.ok).toBe(true);
    expect(statSync(walletPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".degenly")).mode & 0o777).toBe(0o700);
  });

  it("the signer object carries no key material (JSON / keys)", () => {
    const home = tmpHome();
    const r = createWallet(home);
    if (!r.ok) throw new Error("create failed");
    const secret = Buffer.from(Uint8Array.from(JSON.parse(readFileSync(walletPath(home), "utf8")) as number[]).slice(0, 32)).toString("hex");
    expect(Object.keys(r.wallet).sort()).toEqual(["address", "sign"]);
    expect(JSON.stringify(r.wallet)).toBe(JSON.stringify({ address: r.wallet.address }));
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});

describe("DGAJ15 keys: never overwrite, never regenerate", () => {
  it("second create → WALLET_EXISTS, file bytes unchanged (wallet + recovery.json)", () => {
    const home = tmpHome();
    const a = createWallet(home);
    expect(a.ok).toBe(true);
    const bytes = readFileSync(walletPath(home));
    const rec = readFileSync(recoveryPath(home));
    const b = createWallet(home);
    expect(b).toEqual({ ok: false, error: "WALLET_EXISTS" });
    expect(readFileSync(walletPath(home)).equals(bytes)).toBe(true);
    expect(readFileSync(recoveryPath(home)).equals(rec)).toBe(true);
    expect(readdirSync(join(home, ".degenly")).sort()).toEqual([RECOVERY_FILE_NAME, WALLET_FILE_NAME].sort());
  });

  it("corrupt file → WALLET_CORRUPT on load; create still refuses; file kept byte for byte", () => {
    for (const content of ["{not json", JSON.stringify([1, 2, 3]), JSON.stringify(Array(64).fill(300)), JSON.stringify(Array(64).fill(7))]) {
      const home = tmpHome();
      mkdirSync(join(home, ".degenly"), { recursive: true });
      writeFileSync(walletPath(home), content);
      expect(loadWallet(home), content).toEqual({ ok: false, error: "WALLET_CORRUPT" });
      expect(createWallet(home)).toEqual({ ok: false, error: "WALLET_EXISTS" });
      expect(readFileSync(walletPath(home), "utf8")).toBe(content);
      expect(readdirSync(join(home, ".degenly"))).toEqual([WALLET_FILE_NAME]);
      // DGAJ29: no recovery.json is ever written next to an existing (here corrupt) wallet
      expect(existsSync(recoveryPath(home))).toBe(false);
    }
  });

  it("no file → NO_WALLET (nothing created by a load)", () => {
    const home = tmpHome();
    expect(loadWallet(home)).toEqual({ ok: false, error: "NO_WALLET" });
    expect(existsSync(join(home, ".degenly"))).toBe(false);
  });
});

describe("DGAJ15 keys: home directory", () => {
  it("default = the OS home; DEGENLY_HOME only as an absolute path outside the working directory", () => {
    const cwd = process.cwd();
    expect(resolveHome({}, homedir(), cwd)).toEqual({ ok: true, home: homedir() });
    expect(resolveHome({ DEGENLY_HOME: "" }, homedir(), cwd)).toEqual({ ok: true, home: homedir() });
    const t = tmpHome();
    expect(resolveHome({ DEGENLY_HOME: t }, homedir(), cwd)).toEqual({ ok: true, home: t });
    expect(resolveHome({ DEGENLY_HOME: "relative/dir" }, homedir(), cwd)).toEqual({ ok: false, error: "BAD_DEGENLY_HOME" });
    expect(resolveHome({ DEGENLY_HOME: cwd }, homedir(), cwd)).toEqual({ ok: false, error: "BAD_DEGENLY_HOME" });
    expect(resolveHome({ DEGENLY_HOME: join(cwd, "sub") }, homedir(), cwd)).toEqual({ ok: false, error: "BAD_DEGENLY_HOME" });
  });

  it("warning text is the DGAJ-S A4 sentence, word for word", () => {
    expect(AGENT_WALLET_WARNING).toBe(
      "Spending limits apply to trades made through Degenly. An agent that can read files on this computer could read the agent wallet key and move funds outside Degenly. Fund the agent wallet with only what you can afford to lose.",
    );
  });
});
