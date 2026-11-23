/**
 * DGAJ15 (DGAJ-S A3 + A4 "Tavanin siniri"): the agent wallet, created and kept ON THIS COMPUTER.
 *
 *  - Ed25519 key pair from Node's built-in `crypto`; Solana address = base58(32-byte public key).
 *  - File `~/.degenly/agent-wallet.json` = the Solana CLI keypair format (JSON array of 64 bytes: seed ‖ public key).
 *    Home directory, NEVER the working directory. POSIX: file 0600, directory 0700. Windows: under the user
 *    profile (no POSIX modes there; the OS profile ACL applies).
 *  - An existing file is NEVER overwritten (WALLET_EXISTS: a new key for a funded address = lost funds).
 *    A corrupt file is an error (WALLET_CORRUPT): never deleted, never regenerated.
 *  - The key is read for one thing in this card: signing (request + pairing). It is never printed, logged,
 *    returned, put in an error, or sent: the `Signer` keeps the KeyObject in a closure, its fields are the
 *    public address and a `sign` function only.
 *  - `--keychain` (OS credential store) is NOT offered: not measured on the three OSes (DGAJ-S A4 madde 3).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { base58Encode, type Signer } from "./sign.js";

export const DEGENLY_DIR_NAME = ".degenly";
export const WALLET_FILE_NAME = "agent-wallet.json";
export const WALLET_PATH_TEXT = "~/.degenly/agent-wallet.json";

/**
 * DGAJ-S A4 madde 1: the SAME sentence in 3 places (`setup` output, `/bot` safety note, README).
 * DGAJ17 README uses this constant. Do not reword.
 */
export const AGENT_WALLET_WARNING =
  "Spending limits apply to trades made through Degenly. An agent that can read files on this computer could read the agent wallet key and move funds outside Degenly. Fund the agent wallet with only what you can afford to lose.";

/** PKCS#8 DER prefix of a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const POSIX = process.platform !== "win32";

export type WalletError = "NO_WALLET" | "WALLET_CORRUPT" | "WALLET_EXISTS" | "WALLET_WRITE_FAILED";

export function degenlyDir(home: string): string {
  return join(home, DEGENLY_DIR_NAME);
}

export function walletPath(home: string): string {
  return join(degenlyDir(home), WALLET_FILE_NAME);
}

/**
 * The home the live files live under: the OS home. `DEGENLY_HOME` (tests / isolated runs) is taken only as an
 * ABSOLUTE path that is not the working directory or inside it (the key never lands in an agent's project).
 */
export function resolveHome(env: Readonly<Record<string, string | undefined>>, osHome: string, cwd: string): { ok: true; home: string } | { ok: false; error: "BAD_DEGENLY_HOME" } {
  const v = env.DEGENLY_HOME;
  if (v === undefined || v === "") return { ok: true, home: osHome };
  if (!isAbsolute(v)) return { ok: false, error: "BAD_DEGENLY_HOME" };
  const norm = (p: string) => (POSIX ? resolve(p) : resolve(p).toLowerCase());
  const rel = relative(norm(cwd), norm(v));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { ok: false, error: "BAD_DEGENLY_HOME" };
  return { ok: true, home: v };
}

function signerOf(key: KeyObject, publicKey: Uint8Array): Signer {
  const address = base58Encode(publicKey);
  return Object.freeze({
    address,
    sign: (message: Uint8Array): Uint8Array => new Uint8Array(edSign(null, message, key)),
  });
}

function publicKeyOf(key: KeyObject): Uint8Array {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

/** A signer from a 32-byte seed (tests: RFC 8032 vectors). */
export function signerFromSeed(seed: Uint8Array): Signer {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const key = privateKeyFromSeed(seed);
  return signerOf(key, publicKeyOf(key));
}

function seedOf(key: KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "pkcs8" });
  return new Uint8Array(der.subarray(der.length - 32));
}

function ensureDir(home: string): void {
  const dir = degenlyDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(dir, 0o700);
}

/** `setup`: a NEW wallet, only if no file exists. Never overwrites (flag `wx`). */
export function createWallet(home: string): { ok: true; wallet: Signer; path: string } | { ok: false; error: "WALLET_EXISTS" | "WALLET_WRITE_FAILED" } {
  const file = walletPath(home);
  if (existsSync(file)) return { ok: false, error: "WALLET_EXISTS" };
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKeyOf(privateKey);
  const seed = seedOf(privateKey);
  const content = JSON.stringify([...seed, ...pub]);
  seed.fill(0);
  try {
    ensureDir(home);
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    if (POSIX) chmodSync(file, 0o600);
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "EEXIST") return { ok: false, error: "WALLET_EXISTS" };
    return { ok: false, error: "WALLET_WRITE_FAILED" };
  }
  return { ok: true, wallet: signerOf(privateKey, pub), path: file };
}

/** Reads the wallet. Missing → NO_WALLET; anything else than a valid 64-byte keypair → WALLET_CORRUPT (file untouched). */
export function loadWallet(home: string): { ok: true; wallet: Signer } | { ok: false; error: "NO_WALLET" | "WALLET_CORRUPT" } {
  const file = walletPath(home);
  if (!existsSync(file)) return { ok: false, error: "NO_WALLET" };
  let arr: unknown;
  try {
    arr = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "WALLET_CORRUPT" };
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)) {
    return { ok: false, error: "WALLET_CORRUPT" };
  }
  const bytes = Uint8Array.from(arr as number[]);
  const seed = bytes.slice(0, 32);
  try {
    const key = privateKeyFromSeed(seed);
    const pub = publicKeyOf(key);
    // the stored public half must be the one the seed gives (a hand-edited / truncated file is refused)
    if (Buffer.compare(Buffer.from(pub), Buffer.from(bytes.subarray(32))) !== 0) return { ok: false, error: "WALLET_CORRUPT" };
    return { ok: true, wallet: signerOf(key, pub) };
  } catch {
    return { ok: false, error: "WALLET_CORRUPT" };
  } finally {
    seed.fill(0);
    bytes.fill(0);
  }
}
