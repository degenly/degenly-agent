/**
 * DGAJ29: the agent wallet's 12-word recovery phrase. Node's built-in `crypto` only, no dependency.
 *
 *  - BIP39: entropy (16 bytes for a new wallet) <-> words, with the SHA-256 checksum; words -> 64-byte seed with
 *    PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase (empty for Degenly; the official vectors use one).
 *  - SLIP-0010 ed25519: seed -> `m/44'/501'/0'/0'` (Phantom / Solflare default path, so "Import recovery phrase"
 *    in those wallets opens the same address). ed25519 has hardened derivation only.
 *  - An unknown word, a wrong checksum or a wrong word count is an error. Nothing is guessed or corrected
 *    (only case and spacing are normalized).
 *  - Errors never carry a word: the reason is a fixed code.
 *  - Byte buffers that held a secret are zeroed after use by the callers below; JS strings cannot be zeroed, so the
 *    phrase is built as a string only where it must be shown or compared (see keys.ts).
 */
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { BIP39_ENGLISH } from "./bip39-words.js";

export const RECOVERY_WORD_COUNT = 12;
export const RECOVERY_ENTROPY_BYTES = 16;
/** Phantom / Solflare default Solana account (all hardened). */
export const SOLANA_PATH = "m/44'/501'/0'/0'";
const HARDENED = 0x8000_0000;

export type PhraseError = "PHRASE_WORD_COUNT" | "PHRASE_UNKNOWN_WORD" | "PHRASE_CHECKSUM";

const INDEX: ReadonlyMap<string, number> = new Map(BIP39_ENGLISH.map((w, i) => [w, i]));

function validEntropyLength(n: number): boolean {
  return n >= 16 && n <= 32 && n % 4 === 0;
}

/** Word indices (11 bits each) of an entropy of 16-32 bytes (multiple of 4). */
function entropyToIndices(entropy: Uint8Array): number[] {
  if (!validEntropyLength(entropy.length)) throw new Error("entropy must be 16-32 bytes, a multiple of 4");
  const checksumBits = entropy.length / 4;
  const hash = createHash("sha256").update(entropy).digest();
  const totalBits = entropy.length * 8 + checksumBits;
  const bit = (i: number): number => {
    const byte = i < entropy.length * 8 ? (entropy[i >> 3] ?? 0) : (hash[(i - entropy.length * 8) >> 3] ?? 0);
    return (byte >> (7 - (i & 7))) & 1;
  };
  const out: number[] = [];
  for (let w = 0; w < totalBits / 11; w++) {
    let v = 0;
    for (let b = 0; b < 11; b++) v = (v << 1) | bit(w * 11 + b);
    out.push(v);
  }
  hash.fill(0);
  return out;
}

/** BIP39 words of an entropy (16 bytes -> 12 words; the official vectors also use 20-32 bytes). */
export function entropyToWords(entropy: Uint8Array): string[] {
  return entropyToIndices(entropy).map((i) => BIP39_ENGLISH[i] ?? "");
}

/**
 * The phrase as UTF-8 bytes ("w1 w2 ... w12"), built straight from the entropy so the caller can zero it after
 * PBKDF2 (no long-lived string).
 */
export function entropyToPhraseBytes(entropy: Uint8Array): Buffer {
  const idx = entropyToIndices(entropy);
  const parts = idx.map((i) => Buffer.from(BIP39_ENGLISH[i] ?? "", "utf8"));
  const out = Buffer.alloc(parts.reduce((n, p) => n + p.length, 0) + parts.length - 1, 0x20);
  let at = 0;
  for (const p of parts) {
    p.copy(out, at);
    at += p.length + 1;
    p.fill(0);
  }
  idx.fill(0);
  return out;
}

/** Words of a phrase text: NFKD, lower case, any whitespace as separator. Nothing else is changed. */
export function splitPhrase(text: string): string[] {
  return text.normalize("NFKD").trim().toLowerCase().split(/\s+/).filter((w) => w !== "");
}

/**
 * Words -> entropy (BIP39 checksum verified). `wordCounts` = the accepted lengths (default: 12 only, the agent
 * wallet's phrase).
 */
export function wordsToEntropy(words: readonly string[], wordCounts: readonly number[] = [RECOVERY_WORD_COUNT]): { ok: true; entropy: Buffer } | { ok: false; error: PhraseError } {
  if (!wordCounts.includes(words.length) || words.length % 3 !== 0 || words.length < 12 || words.length > 24) return { ok: false, error: "PHRASE_WORD_COUNT" };
  const idx: number[] = [];
  for (const w of words) {
    const i = INDEX.get(w);
    if (i === undefined) return { ok: false, error: "PHRASE_UNKNOWN_WORD" };
    idx.push(i);
  }
  const totalBits = words.length * 11;
  const checksumBits = totalBits / 33;
  const entropyBytes = (totalBits - checksumBits) / 8;
  const bits = new Uint8Array(totalBits);
  idx.forEach((v, w) => {
    for (let b = 0; b < 11; b++) bits[w * 11 + b] = (v >> (10 - b)) & 1;
  });
  idx.fill(0);
  const entropy = Buffer.alloc(entropyBytes);
  for (let i = 0; i < entropyBytes * 8; i++) entropy[i >> 3] = (entropy[i >> 3] ?? 0) | ((bits[i] ?? 0) << (7 - (i & 7)));
  const hash = createHash("sha256").update(entropy).digest();
  let good = true;
  for (let i = 0; i < checksumBits; i++) {
    const expected = ((hash[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
    if ((bits[entropyBytes * 8 + i] ?? 0) !== expected) good = false;
  }
  bits.fill(0);
  hash.fill(0);
  if (!good) {
    entropy.fill(0);
    return { ok: false, error: "PHRASE_CHECKSUM" };
  }
  return { ok: true, entropy };
}

/** BIP39 seed (64 bytes): PBKDF2-HMAC-SHA512(phrase, "mnemonic" + passphrase, 2048). Phrase given as bytes or text. */
export function phraseToSeed(phrase: Uint8Array | string, passphrase = ""): Buffer {
  const pw = typeof phrase === "string" ? Buffer.from(phrase.normalize("NFKD"), "utf8") : phrase;
  const salt = Buffer.from(`mnemonic${passphrase.normalize("NFKD")}`, "utf8");
  const seed = pbkdf2Sync(pw, salt, 2048, 64, "sha512");
  if (typeof phrase === "string") pw.fill(0);
  return seed;
}

/** Parses `m/44'/501'/0'/0'` style paths; ed25519 allows hardened indices only. */
export function parsePath(path: string): number[] {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("path must start with m");
  return parts.slice(1).map((p) => {
    const m = /^(\d+)['H]$/.exec(p);
    if (!m) throw new Error("ed25519 needs hardened indices only");
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n >= HARDENED) throw new Error("index out of range");
    return n + HARDENED;
  });
}

/** SLIP-0010 ed25519: the private key (32 bytes) and chain code at `path` from a seed. */
export function slip10Ed25519(seed: Uint8Array, path: string): { key: Buffer; chainCode: Buffer } {
  let I = createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = Buffer.from(I.subarray(0, 32));
  let chainCode = Buffer.from(I.subarray(32));
  I.fill(0);
  for (const index of parsePath(path)) {
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE(index >>> 0, 33);
    I = createHmac("sha512", chainCode).update(data).digest();
    data.fill(0);
    key.fill(0);
    chainCode.fill(0);
    key = Buffer.from(I.subarray(0, 32));
    chainCode = Buffer.from(I.subarray(32));
    I.fill(0);
  }
  return { key, chainCode };
}

/** Entropy -> the 32-byte ed25519 seed of the Solana account at SOLANA_PATH (intermediates zeroed). */
export function entropyToSolanaSeed(entropy: Uint8Array): Buffer {
  const phrase = entropyToPhraseBytes(entropy);
  const seed = phraseToSeed(phrase);
  phrase.fill(0);
  const { key, chainCode } = slip10Ed25519(seed, SOLANA_PATH);
  seed.fill(0);
  chainCode.fill(0);
  return key;
}
