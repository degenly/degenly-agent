/**
 * DGAJ15: the two texts the agent wallet signs, byte for byte the server's (degenly repo, read only):
 *
 *  1. Bot API request (degenly/src/edge/botApi.ts:26-29, `apiSigningMessage` :244-246, `authenticateApiRequest` :286-312):
 *       `degenly-api-v1:${METHOD}|${pathname + search}|${hex(sha256(body))}|${ts}`   (no body → sha256 of 0 bytes)
 *     Headers x-degenly-key (plain API key), x-degenly-ts (unix ms, |server − ts| ≤ 30 s), x-degenly-sig = base58(ed25519).
 *  2. Pairing code (degenly/src/api/pairing.ts:4-7, :43-54; parser :60-84), DGAJ22 C-1 two-line text:
 *       base58( UTF-8 `Degenly (degenly.app): pair this wallet as an AI agent of <owner>.` "\n"
 *               `degenly-agent-pair-v1:<agent>|<owner>|<nonce>|<ts>|terms:<TERMS_VERSION>|apiTerms:<API_TERMS_VERSION>` ‖ 64-byte signature )
 *
 * The two prefixes differ (domain separation): a request signature can never be a pairing signature.
 * Only PUBLIC data leaves this file: an address, a message, a signature. The signer (./keys.ts) keeps the key.
 */
import { createHash, randomBytes } from "node:crypto";

/** Must equal `TERMS_VERSION` in degenly/src/config/constants.ts:171 (site Terms the agent wallet accepts at pairing). */
export const TERMS_VERSION = "2026-10-9";
/** Must equal `API_TERMS_VERSION` in degenly/src/config/apiConstants.ts:20. */
export const API_TERMS_VERSION = "2026-10-1";
/** Must equal `AGENT_PAIR_PREFIX` in degenly/src/config/apiConstants.ts:157. */
export const AGENT_PAIR_PREFIX = "degenly-agent-pair-v1:";
/** DGAJ22 C-1: the human-readable first line of the pairing text (followed by the owner wallet and "."). */
export const AGENT_PAIR_HUMAN_PREFIX = "Degenly (degenly.app): pair this wallet as an AI agent of ";
/** Must equal `API_SIGNING_PREFIX` in degenly/src/config/apiConstants.ts:101. */
export const API_SIGNING_PREFIX = "degenly-api-v1:";
/** Must equal degenly/src/config/apiConstants.ts:31-33. */
export const API_KEY_HEADER = "x-degenly-key";
export const API_TS_HEADER = "x-degenly-ts";
export const API_SIG_HEADER = "x-degenly-sig";
/** Must equal `API_PAIR_TS_SKEW_MS` (apiConstants.ts:163): a pairing code is accepted for 10 minutes. */
export const API_PAIR_TS_SKEW_MS = 600_000;
/** Must equal `API_PAIR_CODE_MAX_CHARS` (apiConstants.ts:165). */
export const API_PAIR_CODE_MAX_CHARS = 1024;
/** hex(sha256(0 bytes)): the body hash of a request without a body (botApi.ts:29, :256). */
export const EMPTY_BODY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const SIGNATURE_BYTES = 64;

/** What can sign. Holds no key material in its fields (the key lives in a closure, ./keys.ts). */
export interface Signer {
  readonly address: string;
  sign(message: Uint8Array): Uint8Array;
}

// ---- base58 (Bitcoin alphabet): same algorithm as degenly/src/lib/base58.ts (no dependency) ----------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX: Readonly<Record<string, number>> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += ALPHABET[digits[k] ?? 0];
  return out;
}

/** undefined for any non-base58 character. */
export function base58Decode(text: string): Uint8Array | undefined {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const ch = text[i];
    const v = ch === undefined ? undefined : INDEX[ch];
    if (v === undefined) return undefined;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let k = 0; k < bytes.length; k++) out[zeros + k] = bytes[bytes.length - 1 - k] ?? 0;
  return out;
}

/** A Solana public key: base58 that decodes to exactly 32 bytes (degenly/src/lib/base58.ts:54-57). */
export function isSolanaAddress(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  return base58Decode(text)?.length === 32;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- 1. Bot API request ------------------------------------------------------------------------

/** Byte-for-byte `apiSigningMessage` of degenly/src/edge/botApi.ts:244-246. */
export function apiSigningMessage(method: string, pathWithQuery: string, ts: number, bodySha256Hex: string): string {
  return `${API_SIGNING_PREFIX}${method.toUpperCase()}|${pathWithQuery}|${bodySha256Hex}|${ts}`;
}

export interface SignedRequest {
  /** x-degenly-ts */
  ts: string;
  /** x-degenly-sig: base58(64-byte ed25519 signature) */
  sig: string;
  /** the exact signed text (public: method, path, body hash, time) */
  message: string;
}

/** `pathWithQuery` = what the server reads as `url.pathname + url.search`; `body` = the exact bytes sent. */
export function signApiRequest(signer: Signer, method: string, pathWithQuery: string, body: Uint8Array, nowMs: number): SignedRequest {
  const ts = Math.floor(nowMs);
  const message = apiSigningMessage(method, pathWithQuery, ts, sha256Hex(body));
  const sig = base58Encode(signer.sign(new TextEncoder().encode(message)));
  return { ts: String(ts), sig, message };
}

// ---- 2. Pairing code ---------------------------------------------------------------------------

export interface AgentPairingFields {
  agentWallet: string;
  ownerWallet: string;
  nonce: string;
  ts: number;
  termsVersion: string;
  apiTermsVersion: string;
}

/**
 * Byte-for-byte `agentPairingMessage` of degenly/src/api/pairing.ts (DGAJ22 C-1: both repos change together).
 * Two lines, one `\n` between them, no trailing line break. Line 1 is what the human reads in a wallet window:
 *   `Degenly (degenly.app): pair this wallet as an AI agent of <ownerWallet>.`
 *   `degenly-agent-pair-v1:<agent>|<owner>|<nonce>|<ts>|terms:<T>|apiTerms:<A>`
 */
export function agentPairingMessage(f: AgentPairingFields): string {
  return `${AGENT_PAIR_HUMAN_PREFIX}${f.ownerWallet}.\n${AGENT_PAIR_PREFIX}${f.agentWallet}|${f.ownerWallet}|${f.nonce}|${f.ts}|terms:${f.termsVersion}|apiTerms:${f.apiTermsVersion}`;
}

/** Byte-for-byte `encodeAgentPairingCode` of degenly/src/api/pairing.ts:48-54. */
export function encodeAgentPairingCode(message: string, signature: Uint8Array): string {
  const m = new TextEncoder().encode(message);
  const out = new Uint8Array(m.length + signature.length);
  out.set(m, 0);
  out.set(signature, m.length);
  return base58Encode(out);
}

/** Splits a code back into message + signature (tests, self-check). Shape rules are the server's. */
export function decodeAgentPairingCode(code: string): { message: string; signature: Uint8Array } | undefined {
  if (code.length === 0 || code.length > API_PAIR_CODE_MAX_CHARS) return undefined;
  const bytes = base58Decode(code);
  if (!bytes || bytes.length <= SIGNATURE_BYTES) return undefined;
  try {
    const message = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, bytes.length - SIGNATURE_BYTES));
    // DGAJ22 C-1: exactly two lines, the first one the human sentence; the old one-line text is not accepted
    const [human, machine, ...rest] = message.split("\n");
    if (rest.length !== 0 || human === undefined || machine === undefined || !machine.startsWith(AGENT_PAIR_PREFIX)) return undefined;
    const owner = machine.slice(AGENT_PAIR_PREFIX.length).split("|")[1];
    return owner !== undefined && human === `${AGENT_PAIR_HUMAN_PREFIX}${owner}.` ? { message, signature: bytes.slice(bytes.length - SIGNATURE_BYTES) } : undefined;
  } catch {
    return undefined;
  }
}

/** 24 random bytes → 32 chars of [A-Za-z0-9_-] (server: /^[A-Za-z0-9_-]{16,64}$/, single use per agent wallet). */
export function newPairingNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** The code `setup` / `pair` print. Valid for API_PAIR_TS_SKEW_MS after `nowMs`, once (nonce). */
export function createPairingCode(signer: Signer, ownerWallet: string, nowMs: number, nonce: string = newPairingNonce()): { code: string; fields: AgentPairingFields } {
  const fields: AgentPairingFields = {
    agentWallet: signer.address,
    ownerWallet,
    nonce,
    ts: Math.floor(nowMs),
    termsVersion: TERMS_VERSION,
    apiTermsVersion: API_TERMS_VERSION,
  };
  const message = agentPairingMessage(fields);
  return { code: encodeAgentPairingCode(message, signer.sign(new TextEncoder().encode(message))), fields };
}
