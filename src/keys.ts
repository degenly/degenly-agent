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
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RECOVERY_ENTROPY_BYTES, entropyToSolanaSeed, entropyToWords } from "./mnemonic.js";
import { base58Encode, type Signer } from "./sign.js";

export const DEGENLY_DIR_NAME = ".degenly";
export const WALLET_FILE_NAME = "agent-wallet.json";
export const WALLET_PATH_TEXT = "~/.degenly/agent-wallet.json";
/**
 * DGAJ29: the recovery entropy of a wallet made by `setup` / `recover` (`{"v":1,"entropyHex":"..."}`), next to the
 * wallet file, same protection (0600, never overwritten). Wallets made before DGAJ29 have none and keep working.
 */
export const RECOVERY_FILE_NAME = "recovery.json";
export const RECOVERY_PATH_TEXT = "~/.degenly/recovery.json";

/** DGAJ29: the `setup` line about the phrase (the words themselves are never in `setup` output). Do not reword. */
export const RECOVERY_SETUP_TEXT =
  "Recovery phrase: run `degenly recovery-phrase` yourself in your own terminal and write the 12 words down. Degenly never sees or stores them.";

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

function ensureDir(home: string): void {
  const dir = degenlyDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(dir, 0o700);
}

export function recoveryPath(home: string): string {
  return join(degenlyDir(home), RECOVERY_FILE_NAME);
}

function isEexist(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "EEXIST";
}

/** Writes a new file 0600 with `wx` (never over an existing one). */
function writeNew(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  if (POSIX) chmodSync(file, 0o600);
}

/**
 * Wallet file + (optionally) recovery file from 16 bytes of entropy. The recovery file is written first, then the
 * wallet; a wallet write that fails removes the recovery file it just made (that wallet never existed).
 * Every secret buffer is zeroed before returning.
 */
function writeFromEntropy(home: string, entropy: Uint8Array, writeRecovery: boolean): { ok: true; wallet: Signer; path: string } | { ok: false; error: "WALLET_EXISTS" | "RECOVERY_EXISTS" | "WALLET_WRITE_FAILED" } {
  const file = walletPath(home);
  const rfile = recoveryPath(home);
  const seed = entropyToSolanaSeed(entropy);
  const key = privateKeyFromSeed(seed);
  const pub = publicKeyOf(key);
  const content = JSON.stringify([...seed, ...pub]);
  seed.fill(0);
  const recovery = writeRecovery ? JSON.stringify({ v: 1, entropyHex: Buffer.from(entropy).toString("hex") }) : "";
  try {
    ensureDir(home);
  } catch {
    return { ok: false, error: "WALLET_WRITE_FAILED" };
  }
  if (writeRecovery) {
    try {
      writeNew(rfile, recovery);
    } catch (e) {
      return { ok: false, error: isEexist(e) ? "RECOVERY_EXISTS" : "WALLET_WRITE_FAILED" };
    }
  }
  try {
    writeNew(file, content);
  } catch (e) {
    if (writeRecovery) {
      try {
        unlinkSync(rfile);
      } catch {
        // left in place: it belongs to a wallet that was never written
      }
    }
    return { ok: false, error: isEexist(e) ? "WALLET_EXISTS" : "WALLET_WRITE_FAILED" };
  }
  return { ok: true, wallet: signerOf(key, pub), path: file };
}

/**
 * `setup`: a NEW wallet, only if no wallet file exists. Never overwrites (flag `wx`).
 * DGAJ29: the key comes from 16 random bytes of entropy (BIP39 12 words -> SLIP-0010 m/44'/501'/0'/0'); the entropy
 * goes to `recovery.json`. A `recovery.json` left without a wallet is never overwritten (RECOVERY_EXISTS: it may be
 * the only copy of a funded wallet's phrase).
 */
export function createWallet(home: string): { ok: true; wallet: Signer; path: string } | { ok: false; error: "WALLET_EXISTS" | "RECOVERY_EXISTS" | "WALLET_WRITE_FAILED" } {
  if (existsSync(walletPath(home))) return { ok: false, error: "WALLET_EXISTS" };
  if (existsSync(recoveryPath(home))) return { ok: false, error: "RECOVERY_EXISTS" };
  const entropy = randomBytes(RECOVERY_ENTROPY_BYTES);
  try {
    return writeFromEntropy(home, entropy, true);
  } finally {
    entropy.fill(0);
  }
}

/**
 * `recover`: rebuilds the wallet file (and `recovery.json`) from the entropy of a checked phrase.
 * A wallet file that exists is never overwritten (WALLET_EXISTS). An existing `recovery.json` is kept if it holds
 * the same entropy, refused otherwise (RECOVERY_EXISTS).
 */
export function restoreWallet(home: string, entropy: Uint8Array): { ok: true; wallet: Signer; path: string } | { ok: false; error: "WALLET_EXISTS" | "RECOVERY_EXISTS" | "RECOVERY_CORRUPT" | "WALLET_WRITE_FAILED" } {
  if (existsSync(walletPath(home))) return { ok: false, error: "WALLET_EXISTS" };
  let writeRecovery = true;
  if (existsSync(recoveryPath(home))) {
    const r = loadRecoveryEntropy(home);
    if (!r.ok) return { ok: false, error: r.error === "NO_RECOVERY_PHRASE" ? "WALLET_WRITE_FAILED" : r.error };
    const same = Buffer.compare(r.entropy, Buffer.from(entropy)) === 0;
    r.entropy.fill(0);
    if (!same) return { ok: false, error: "RECOVERY_EXISTS" };
    writeRecovery = false;
  }
  return writeFromEntropy(home, entropy, writeRecovery);
}

/** The entropy in `recovery.json`. Missing → NO_RECOVERY_PHRASE; anything but `{v:1, entropyHex: 32 hex}` → RECOVERY_CORRUPT. */
export function loadRecoveryEntropy(home: string): { ok: true; entropy: Buffer } | { ok: false; error: "NO_RECOVERY_PHRASE" | "RECOVERY_CORRUPT" } {
  const file = recoveryPath(home);
  if (!existsSync(file)) return { ok: false, error: "NO_RECOVERY_PHRASE" };
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "RECOVERY_CORRUPT" };
  }
  const o = typeof v === "object" && v !== null ? (v as { v?: unknown; entropyHex?: unknown }) : {};
  if (o.v !== 1 || typeof o.entropyHex !== "string" || !/^[0-9a-f]{32}$/.test(o.entropyHex)) return { ok: false, error: "RECOVERY_CORRUPT" };
  return { ok: true, entropy: Buffer.from(o.entropyHex, "hex") };
}

/** Address the recovery entropy opens (m/44'/501'/0'/0'). */
function addressOfEntropy(entropy: Uint8Array): string {
  const seed = entropyToSolanaSeed(entropy);
  try {
    return base58Encode(publicKeyOf(privateKeyFromSeed(seed)));
  } finally {
    seed.fill(0);
  }
}

/**
 * The 12 words for `degenly recovery-phrase` (the CLI shows them only in an interactive terminal).
 * If a wallet file exists, the words must open THAT address (RECOVERY_MISMATCH otherwise: wrong words are never shown).
 */
export function recoveryWords(home: string): { ok: true; words: string[]; address: string; walletFile: boolean } | { ok: false; error: "NO_RECOVERY_PHRASE" | "RECOVERY_CORRUPT" | "RECOVERY_MISMATCH" | "WALLET_CORRUPT" } {
  const r = loadRecoveryEntropy(home);
  if (!r.ok) return r;
  try {
    const address = addressOfEntropy(r.entropy);
    const hasWallet = existsSync(walletPath(home));
    if (hasWallet) {
      const w = loadWallet(home);
      if (!w.ok) return { ok: false, error: w.error === "NO_WALLET" ? "WALLET_CORRUPT" : w.error };
      if (w.wallet.address !== address) return { ok: false, error: "RECOVERY_MISMATCH" };
    }
    return { ok: true, words: entropyToWords(r.entropy), address, walletFile: hasWallet };
  } finally {
    r.entropy.fill(0);
  }
}

/**
 * DGAJ34 (DGAJ31 G-1): after the human wrote the 12 words down, `recovery.json` can be removed so no file on this
 * computer holds the phrase any more. Next to it, `recovery-deleted.json` records ONLY the public address whose
 * phrase was removed (`{"v":1,"address":"..."}`), so `degenly recovery-phrase` can tell "deleted by you" apart
 * from "wallet older than recovery phrases". It holds no secret.
 */
export const RECOVERY_DELETED_FILE_NAME = "recovery-deleted.json";

/** The marker path (see RECOVERY_DELETED_FILE_NAME). */
export function recoveryDeletedPath(home: string): string {
  return join(degenlyDir(home), RECOVERY_DELETED_FILE_NAME);
}

/**
 * DGAJ34: deletes `~/.degenly/recovery.json` and nothing else. The path comes from the constant (no path argument);
 * `agent-wallet.json`, `owner.json`, `credentials.json` and every other file stay. The wallet keeps working (its key
 * is in `agent-wallet.json`). Before the delete, the marker gets the wallet's public address (best effort: a marker
 * that cannot be written never stops the delete). Called by the CLI only after the human typed DELETE in a TTY.
 */
export function deleteRecoveryFile(home: string): { ok: true } | { ok: false; error: "NO_RECOVERY_PHRASE" | "RECOVERY_DELETE_FAILED" } {
  const file = recoveryPath(home);
  if (!existsSync(file)) return { ok: false, error: "NO_RECOVERY_PHRASE" };
  const w = loadWallet(home);
  if (w.ok) {
    try {
      writeFileSync(recoveryDeletedPath(home), JSON.stringify({ v: 1, address: w.wallet.address }), { mode: 0o600 });
    } catch {
      // the marker only picks the message `recovery-phrase` shows later
    }
  }
  try {
    unlinkSync(file);
  } catch {
    return { ok: false, error: "RECOVERY_DELETE_FAILED" };
  }
  return existsSync(file) ? { ok: false, error: "RECOVERY_DELETE_FAILED" } : { ok: true };
}

/** DGAJ34: true when `recovery.json` is gone because the human deleted it for THIS wallet (the marker's address). */
export function recoveryDeletedFor(home: string, address: string): boolean {
  if (existsSync(recoveryPath(home))) return false;
  try {
    const v: unknown = JSON.parse(readFileSync(recoveryDeletedPath(home), "utf8"));
    const o = typeof v === "object" && v !== null ? (v as { v?: unknown; address?: unknown }) : {};
    return o.v === 1 && o.address === address;
  } catch {
    return false;
  }
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
