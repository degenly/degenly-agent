/**
 * DGAJ16: ../src/tx.ts on REAL Jupiter `/order` transactions, copied byte for byte from the degenly repo (read only):
 *   METIS = src/data/fixtures/jupiter-swap-v2-order-metis-sol-usdc.json `transaction` (v0, 1 signer = the taker)
 *   RFQ   = src/data/fixtures/jupiter-swap-v2-order-jupiterz-rfq.json `transaction`  (v0, 2 signers: market maker + taker)
 * TAKER = degenly src/swap/testFixtures.ts:24 FIXTURE_TAKER (recorded keyless 10.10.2026, never signed). The server's own
 * test (src/swap/programs.test.ts:27-54) asserts the same facts (v0, taker signs, RFQ = 2 signatures, fee payer ≠ taker).
 * To sign, the taker's 32 key bytes are replaced by a test key (same trick as programs.test.ts:16-24 `swapKey`).
 */
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signerFromSeed } from "../src/keys.js";
import { base58Decode, base58Encode, type Signer } from "../src/sign.js";
import { agentSlot, base64ToBytes, bytesToBase64, parseTxLayout, signTransactionFor } from "../src/tx.js";

const METIS_TX =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAFCEjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTm3sTeRGTwuXxew5/kivghLMd/7RlS2oFJdI1UTmJL6wANhMFxmHie5lj8TFWhd75WFwp5jDWzhXPBOqZlIgYcLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAD80T2gQVWQE89K66GoTtcCOtT/IahHR/87Basw+oIHwwR51VvyMcBu7nTFbs5oFQf9sbLeo/SOUQKxzaJWvBOPBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKliQrk0Uv/ujdii1Gc5zV3hfsbAB4Q6ISb19XxcvSE7qAYEAAUC4NwBAAQACQOTBAAAAAAAAAMCAAIMAgAAAICWmAAAAAAABwECAREGGwACAQ8NBwcGDAYIEgALAgEJCg8NEBETBwcFDii7ZPrMMcSvFICWmAAAAAAAOK4QAAAAAAAWAAIAAAABAAAAlwAQJwABBwMCAAABCQIpv5UHKk+/BN9xdZPnOLzMIScoFcJHGoDZ+fVVsNSEJQEhBAAoARe1Dh+3xL8b+dTiI1DcM69hfXHQaeljCtwigIUwexkpUQPq7/EE8jGFLg==";
const RFQ_TX =
  "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAIABwxl4eWU9W+LbzHkYy5erq32+K0Kp0kwgKUELcMBr/mwIUjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTmcDCKCuZQ9H/DlEA+/iNtI7O40wgE0jyf8lfq3Bho9+CZJvqX+s3Rd+H42x7E8MWXLZ7PclfEylFJvyr9Z4oLvd7E3kRk8Ll8XsOf5Ir4ISzHf+0ZUtqBSXSNVE5iS+sAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKlKWEn7cqO76R/cWw5qV/Y8Why0WyBnpu0MrNNjlcihAoyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWEA0fj9Pm0qtiDvK+2I/SW6kAm2ooxs4K/rGcXRa5oMLgQGAAkDzh4AAAAAAAAGAAUCM0UAAAoGAQQBCwUIAQEJCwEACQMEAgcICwgFJahgt6NcCiigAMqaOwAAAAAj8IMGAAAAACqOyWoAAAAAAgAAAAAA";
const TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
/** degenly fixture: `signatureFeePayer` of the RFQ order (the market maker). */
const RFQ_MAKER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const bytes = (b64: string): Uint8Array => {
  const b = base64ToBytes(b64);
  if (!b) throw new Error("fixture is not base64");
  return b;
};

/** Every occurrence of the 32 key bytes of `from` replaced by those of `to`. */
function swapKey(tx: Uint8Array, from: string, to: string): Uint8Array {
  const a = base58Decode(from);
  const b = base58Decode(to);
  if (!a || !b || a.length !== 32 || b.length !== 32) throw new Error("bad key");
  const out = new Uint8Array(tx);
  let n = 0;
  for (let i = 0; i + 32 <= out.length; i++) {
    if (a.every((v, j) => out[i + j] === v)) {
      out.set(b, i);
      n++;
    }
  }
  if (n === 0) throw new Error("key not found");
  return out;
}

function verifyEd(address: string, msg: Uint8Array, sig: Uint8Array): boolean {
  const pk = base58Decode(address) ?? new Uint8Array(0);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pk)]);
  return edVerify(null, msg, createPublicKey({ key: spki, format: "der", type: "spki" }), sig);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const seed = (n: number) => new Uint8Array(32).fill(n);

function counting(s: Signer): { signer: Signer; calls: () => number } {
  let n = 0;
  return {
    signer: { address: s.address, sign: (m) => { n++; return s.sign(m); } },
    calls: () => n,
  };
}

describe("DGAJ16 tx layout on recorded Jupiter transactions", () => {
  it("metis SOL→USDC: v0, 1 signature slot at offset 1, message at 65, the taker is signer 0", () => {
    const l = parseTxLayout(bytes(METIS_TX));
    expect(l).toBeDefined();
    expect(l?.version).toBe(0);
    expect(l?.numSignatures).toBe(1);
    expect(l?.slotsOffset).toBe(1);
    expect(l?.messageOffset).toBe(65);
    expect(l?.requiredSignatures).toBe(1);
    expect(l?.signers).toEqual([TAKER]);
    // the message starts with the v0 marker 0x80, then the header byte requiredSignatures = 1
    const t = bytes(METIS_TX);
    expect(t[65]).toBe(0x80);
    expect(t[66]).toBe(1);
    // the unsigned quote carries an all-zero slot
    expect([...t.subarray(1, 65)].every((x) => x === 0)).toBe(true);
  });

  it("JupiterZ RFQ: 2 slots, message at 129, signers = [market maker, taker] (the taker signs slot 1)", () => {
    const l = parseTxLayout(bytes(RFQ_TX));
    expect(l?.numSignatures).toBe(2);
    expect(l?.messageOffset).toBe(1 + 2 * 64);
    expect(l?.signers).toEqual([RFQ_MAKER, TAKER]);
    expect(agentSlot(bytes(RFQ_TX), TAKER)).toMatchObject({ ok: true, slot: 1 });
  });

  it("signs ONLY the agent's slot over the message bytes; every other byte (message, other slot) unchanged", () => {
    const s = signerFromSeed(seed(7));
    for (const [b64, slot] of [[METIS_TX, 0], [RFQ_TX, 1]] as const) {
      const quoted = swapKey(bytes(b64), TAKER, s.address);
      const before = new Uint8Array(quoted);
      const r = signTransactionFor(quoted, s);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.slot).toBe(slot);
      const off = r.layout.messageOffset;
      // GF1 (server swapApi.ts:875): the signed message is byte-identical to the quoted one
      expect(sha(r.signed.subarray(off))).toBe(sha(quoted.subarray(off)));
      expect(r.signed.length).toBe(quoted.length);
      const sig = r.signed.subarray(1 + slot * 64, 1 + slot * 64 + 64);
      expect(verifyEd(s.address, quoted.subarray(off), sig)).toBe(true);
      // the other slot (RFQ maker) stays as quoted (zeros)
      for (let i = 0; i < r.layout.numSignatures; i++) {
        if (i === slot) continue;
        expect([...r.signed.subarray(1 + i * 64, 1 + i * 64 + 64)]).toEqual([...quoted.subarray(1 + i * 64, 1 + i * 64 + 64)]);
      }
      // the input is not modified in place
      expect([...quoted]).toEqual([...before]);
    }
  });

  it("TX_NOT_FOR_WALLET: the agent is not a signer → nothing is signed (signer never called)", () => {
    const c = counting(signerFromSeed(seed(8)));
    expect(signTransactionFor(bytes(METIS_TX), c.signer)).toEqual({ ok: false, error: "TX_NOT_FOR_WALLET" });
    expect(c.calls()).toBe(0);
  });

  it("TX_NOT_FOR_WALLET: the agent's key is in the message but NOT among the signers (e.g. a program / account key)", () => {
    const c = counting(signerFromSeed(seed(9)));
    const asAccount = swapKey(bytes(METIS_TX), JUPITER, c.signer.address);
    expect(parseTxLayout(asAccount)?.signers).toEqual([TAKER]);
    expect(signTransactionFor(asAccount, c.signer)).toEqual({ ok: false, error: "TX_NOT_FOR_WALLET" });
    // RFQ: the market maker's slot is not the agent's either
    expect(agentSlot(bytes(RFQ_TX), c.signer.address)).toEqual({ ok: false, error: "TX_NOT_FOR_WALLET" });
    expect(c.calls()).toBe(0);
  });

  it("TX_INVALID (fail closed): truncated, trailing byte, message version 1, slot count ≠ requiredSignatures, garbage", () => {
    const s = signerFromSeed(seed(10));
    const t = swapKey(bytes(METIS_TX), TAKER, s.address);
    const v1 = new Uint8Array(t);
    v1[65] = 0x81;
    const slots2 = new Uint8Array([2, ...new Uint8Array(64), ...t.subarray(1)]);
    for (const bad of [t.subarray(0, t.length - 5), new Uint8Array([...t, 0]), v1, slots2, new Uint8Array([1, 2, 3]), new Uint8Array(0)]) {
      expect(parseTxLayout(bad)).toBeUndefined();
      expect(signTransactionFor(bad, s)).toEqual({ ok: false, error: "TX_INVALID" });
    }
  });

  it("base64: strict decode (round trip of the fixture; junk refused)", () => {
    expect(bytesToBase64(bytes(METIS_TX))).toBe(METIS_TX);
    expect(base64ToBytes("not base64!")).toBeUndefined();
    expect(base64ToBytes("")).toBeUndefined();
    expect(base64ToBytes("abc")).toBeUndefined();
    expect(base58Encode(base58Decode(TAKER) ?? new Uint8Array(0))).toBe(TAKER);
  });
});
