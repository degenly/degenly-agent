/**
 * DGAJ15: the two signed texts of the live mode, locked to the server (degenly repo, read only):
 *  - Bot API request: `degenly-api-v1:METHOD|pathWithQuery|sha256hex(body)|ts`, header x-degenly-sig = base58(ed25519)
 *    (degenly/src/edge/botApi.ts:27-29, :244-246, :309-312).
 *  - Pairing code: base58(UTF-8 message ‖ 64-byte signature) of
 *    `degenly-agent-pair-v1:<agent>|<owner>|<nonce>|<ts>|terms:<TERMS_VERSION>|apiTerms:<API_TERMS_VERSION>`
 *    (degenly/src/api/pairing.ts:4-7, :43-54, parser :60-84).
 * The degenly repo has NO fixed signature vector (its tests sign with fresh random WebCrypto keys), so the
 * STRING vectors are copied as is and every signature is verified with WebCrypto (the server's verifier,
 * degenly/src/edge/auth.ts:172) plus the RFC 8032 fixed-seed vector.
 */
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signerFromSeed } from "../src/keys.js";
import {
  AGENT_PAIR_PREFIX,
  API_PAIR_CODE_MAX_CHARS,
  API_SIGNING_PREFIX,
  API_TERMS_VERSION,
  EMPTY_BODY_SHA256_HEX,
  TERMS_VERSION,
  agentPairingMessage,
  apiSigningMessage,
  base58Decode,
  base58Encode,
  createPairingCode,
  decodeAgentPairingCode,
  isSolanaAddress,
  newPairingNonce,
  sha256Hex,
  signApiRequest,
  type AgentPairingFields,
} from "../src/sign.js";

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** RFC 8032 §7.1 TEST 1 (empty message). */
const RFC_SEED = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const RFC_PUB = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
const RFC_SIG = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");

/** Same check the server runs (WebCrypto Ed25519 verify with the PUBLIC key = the base58 address). */
async function serverVerify(address: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const pk = base58Decode(address);
  if (!pk || pk.length !== 32 || signature.length !== 64) return false;
  const key = await webcrypto.subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]);
  return webcrypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

// Copied from the server parser (degenly/src/api/pairing.ts:38-40): a code the server would refuse fails here.
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TS_RE = /^\d{1,16}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

describe("DGAJ15 sign: server string vectors, copied as is", () => {
  it("botApi.test.ts:331 + dgapi3.test.ts:293 request vectors", () => {
    expect(apiSigningMessage("get", "/v1/x", 1, "ab")).toBe("degenly-api-v1:GET|/v1/x|ab|1");
    expect(apiSigningMessage("get", "/v1/x?a=1", 7, "ab")).toBe("degenly-api-v1:GET|/v1/x?a=1|ab|7");
  });

  it("dgaj7.test.ts:193-197 pairing vector + domain separation (DGAJ22 C-1: two lines, the first one human-readable)", () => {
    expect(AGENT_PAIR_PREFIX).toBe("degenly-agent-pair-v1:");
    expect(API_SIGNING_PREFIX).toBe("degenly-api-v1:");
    const f: AgentPairingFields = { agentWallet: "Agent111", ownerWallet: "Owner222", nonce: "n0nce", ts: 1700000000000, termsVersion: "T1", apiTermsVersion: "A1" };
    expect(agentPairingMessage(f)).toBe("Degenly (degenly.app): pair this wallet as an AI agent of Owner222.\ndegenly-agent-pair-v1:Agent111|Owner222|n0nce|1700000000000|terms:T1|apiTerms:A1");
    expect(apiSigningMessage("GET", "/v1/whoami", 1, "00").startsWith(AGENT_PAIR_PREFIX)).toBe(false);
  });

  it("DGAJ22 C-1 shared vector (byte for byte the same test in both repos)", () => {
    const f: AgentPairingFields = { agentWallet: "AGENT", ownerWallet: "OWNER", nonce: "n1", ts: 1700000000000, termsVersion: "T1", apiTermsVersion: "A1" };
    const m = agentPairingMessage(f);
    expect(m).toBe("Degenly (degenly.app): pair this wallet as an AI agent of OWNER.\ndegenly-agent-pair-v1:AGENT|OWNER|n1|1700000000000|terms:T1|apiTerms:A1");
    expect(m.split("\n")).toHaveLength(2);
    expect(m.endsWith("\n")).toBe(false);
    expect(m.includes("\r")).toBe(false);
    expect(Buffer.from(m, "utf8").toString("hex")).toBe(Buffer.from("Degenly (degenly.app): pair this wallet as an AI agent of OWNER.\ndegenly-agent-pair-v1:AGENT|OWNER|n1|1700000000000|terms:T1|apiTerms:A1", "utf8").toString("hex"));
  });

  it("terms versions = the server constants (constants.ts:171, apiConstants.ts:20)", () => {
    expect(TERMS_VERSION).toBe("2026-10-9");
    expect(API_TERMS_VERSION).toBe("2026-10-1");
  });

  it("empty body → sha256 of 0 bytes (botApi.ts:29, :256)", () => {
    expect(EMPTY_BODY_SHA256_HEX).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_BODY_SHA256_HEX);
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("DGAJ15 sign: base58 (Bitcoin alphabet, same as degenly/src/lib/base58.ts)", () => {
  it("known values + leading zeros + round trip", () => {
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(base58Decode("So11111111111111111111111111111111111111112")?.length).toBe(32);
    expect(base58Encode(utf8("hello world"))).toBe("StV1DL6CwTryKyV");
    const b = new Uint8Array([0, 0, 1, 2, 255, 0, 7]);
    expect(Array.from(base58Decode(base58Encode(b)) ?? [])).toEqual(Array.from(b));
    expect(base58Decode("0OIl")).toBeUndefined();
    expect(isSolanaAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe(true);
    expect(isSolanaAddress("bonk")).toBe(false);
    expect(isSolanaAddress("1".repeat(44))).toBe(false); // decodes to 44 zero bytes, not 32
  });
});

describe("DGAJ15 sign: fixed-seed signatures", () => {
  it("RFC 8032 TEST 1: address = base58(public key), signature byte for byte", async () => {
    const s = signerFromSeed(RFC_SEED);
    expect(s.address).toBe(base58Encode(RFC_PUB));
    expect(Buffer.from(s.sign(new Uint8Array(0))).toString("hex")).toBe(Buffer.from(RFC_SIG).toString("hex"));
    expect(await serverVerify(s.address, new Uint8Array(0), RFC_SIG)).toBe(true);
  });

  it("request signature, fixed seed: GET /v1/whoami (empty body) pinned + server-verified", async () => {
    const s = signerFromSeed(RFC_SEED);
    const r = signApiRequest(s, "GET", "/v1/whoami", new Uint8Array(0), 1791594000000);
    expect(r.message).toBe(`degenly-api-v1:GET|/v1/whoami|${EMPTY_BODY_SHA256_HEX}|1791594000000`);
    expect(r.ts).toBe("1791594000000");
    // package-generated vector (the degenly repo has none): ed25519 is deterministic, so this locks the bytes
    expect(r.sig).toBe(PINNED_WHOAMI_SIG);
    expect(await serverVerify(s.address, utf8(r.message), base58Decode(r.sig) ?? new Uint8Array(0))).toBe(true);
  });

  it("request signature with a body: POST /v1/execute hashes the exact body bytes", async () => {
    const s = signerFromSeed(RFC_SEED);
    const body = utf8('{"signedTransaction":"AQ==","requestId":"r1"}');
    const r = signApiRequest(s, "post", "/v1/execute", body, 1791594000001);
    expect(r.message).toBe(`degenly-api-v1:POST|/v1/execute|${sha256Hex(body)}|1791594000001`);
    expect(await serverVerify(s.address, utf8(r.message), base58Decode(r.sig) ?? new Uint8Array(0))).toBe(true);
    // a different body (what the server would hash) does not verify
    const other = apiSigningMessage("POST", "/v1/execute", 1791594000001, sha256Hex(utf8('{"signedTransaction":"AQ==","requestId":"r2"}')));
    expect(await serverVerify(s.address, utf8(other), base58Decode(r.sig) ?? new Uint8Array(0))).toBe(false);
  });
});

describe("DGAJ15 sign: pairing code", () => {
  const OWNER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  it("decodes to message ‖ 64-byte signature; message passes the server parser rules; signature verifies", async () => {
    const s = signerFromSeed(RFC_SEED);
    const { code, fields } = createPairingCode(s, OWNER, 1791594000000, "abcdefghijklmnop_-12");
    expect(fields).toEqual({ agentWallet: s.address, ownerWallet: OWNER, nonce: "abcdefghijklmnop_-12", ts: 1791594000000, termsVersion: TERMS_VERSION, apiTermsVersion: API_TERMS_VERSION });
    const d = decodeAgentPairingCode(code);
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.message).toBe(`Degenly (degenly.app): pair this wallet as an AI agent of ${OWNER}.\ndegenly-agent-pair-v1:${s.address}|${OWNER}|abcdefghijklmnop_-12|1791594000000|terms:2026-10-9|apiTerms:2026-10-1`);
    expect(d.signature.length).toBe(64);
    expect(code.length).toBeLessThanOrEqual(API_PAIR_CODE_MAX_CHARS);
    // server parser rules (pairing.ts:70-82), applied to the machine line (line 2)
    const [human, machine = ""] = d.message.split("\n");
    expect(human).toBe(`Degenly (degenly.app): pair this wallet as an AI agent of ${OWNER}.`);
    const parts = machine.slice(AGENT_PAIR_PREFIX.length).split("|");
    expect(machine.startsWith(AGENT_PAIR_PREFIX)).toBe(true);
    expect(parts).toHaveLength(6);
    expect(isSolanaAddress(parts[0] ?? "") && isSolanaAddress(parts[1] ?? "")).toBe(true);
    expect(NONCE_RE.test(parts[2] ?? "") && TS_RE.test(parts[3] ?? "")).toBe(true);
    expect(VERSION_RE.test((parts[4] ?? "").slice("terms:".length)) && VERSION_RE.test((parts[5] ?? "").slice("apiTerms:".length))).toBe(true);
    expect(agentPairingMessage(fields)).toBe(d.message);
    expect(await serverVerify(s.address, utf8(d.message), d.signature)).toBe(true);
    // the signature covers the message: a changed owner does not verify
    expect(await serverVerify(s.address, utf8(d.message.replace(OWNER, s.address)), d.signature)).toBe(false);
  });

  it("random nonces fit the server's NONCE_RE and do not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = newPairingNonce();
      expect(NONCE_RE.test(n), n).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(50);
  });

  it("a pairing signature is never a request signature (different prefix)", () => {
    const s = signerFromSeed(RFC_SEED);
    const { code } = createPairingCode(s, OWNER, 1, "abcdefghijklmnop");
    const d = decodeAgentPairingCode(code);
    expect(d?.message.startsWith(API_SIGNING_PREFIX)).toBe(false);
    expect(d?.message.includes(API_SIGNING_PREFIX)).toBe(false);
  });

  it("DGAJ22 C-1: the old one-line text is no longer produced or accepted", () => {
    const s = signerFromSeed(RFC_SEED);
    const old = `degenly-agent-pair-v1:${s.address}|${OWNER}|abcdefghijklmnop|1|terms:${TERMS_VERSION}|apiTerms:${API_TERMS_VERSION}`;
    const oldCode = base58Encode(new Uint8Array([...utf8(old), ...s.sign(utf8(old))]));
    expect(decodeAgentPairingCode(oldCode)).toBeUndefined();
    const { code } = createPairingCode(s, OWNER, 1, "abcdefghijklmnop");
    expect(decodeAgentPairingCode(code)?.message.startsWith("Degenly (degenly.app): ")).toBe(true);
  });
});

/** Filled from the first run of the package's own signer (see the report: "imza vektoru ana depoda yok"). */
const PINNED_WHOAMI_SIG = "2Ya3B641t69BkM1qHcfG51kJHxuoHUEvmXLfb86cFU441cVvrLmztV5i8DS5Xs5GTvDLrENw7ftXBEBPTEYTRW5K";
