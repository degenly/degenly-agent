/**
 * DGAJ16: signs the Solana transaction of a `/v1/quote` answer with the agent wallet. No dependency (node:crypto
 * ed25519 lives in ./keys.ts behind `Signer`); the byte layout is the server's own decoder, read only:
 *
 *   wire tx   = compact-u16 N ‖ N × 64-byte signature slot ‖ MESSAGE          (degenly/src/swap/programs.ts:93-155)
 *   MESSAGE   = [0x80 | version (v0 only)] ‖ requiredSignatures ‖ readonlySigned ‖ readonlyUnsigned
 *               ‖ compact-u16 K ‖ K × 32-byte static keys ‖ 32-byte blockhash ‖ instructions [‖ lookup tables (v0)]
 *   signed    = the MESSAGE bytes (everything after the slots: programs.ts:164-173 `signedMessageBytes`)
 *   slot i    = signer keys[i], i < requiredSignatures (degenly/src/orders/e2e.test.ts:86-93 `signWire`)
 *
 * Fail closed: anything not decoded with certainty (other message version, trailing / missing bytes, slot count
 * != requiredSignatures, more signers than keys) → TX_INVALID; the agent wallet not among the signers →
 * TX_NOT_FOR_WALLET (nothing is signed). Only the agent's own slot is written; every other byte stays as quoted,
 * so the server's GF1 check (sha256 of the message == the quoted one, swapApi.ts:875-880) holds.
 *
 * There is NO export that signs caller-given bytes for a tool: ./tools/live-trade.ts calls this only with the
 * transaction of the quote it fetched itself in the same call.
 */
import { base58Encode, type Signer } from "./sign.js";

export interface TxLayout {
  version: "legacy" | 0;
  /** number of 64-byte signature slots */
  numSignatures: number;
  /** offset of the first slot (= length of the compact-u16 slot count) */
  slotsOffset: number;
  /** offset of the message (what is signed) */
  messageOffset: number;
  requiredSignatures: number;
  /** keys[0 .. requiredSignatures) in order: slot i belongs to signers[i] */
  signers: string[];
}

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  byte(): number {
    const v = this.b[this.o];
    if (v === undefined) throw new RangeError("eof");
    this.o++;
    return v;
  }
  /** Solana compact-u16 (same as programs.ts Reader.cu16) */
  cu16(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const x = this.byte();
      v |= (x & 0x7f) << (7 * i);
      if ((x & 0x80) === 0) return v;
    }
    throw new RangeError("bad compact-u16");
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.o + n > this.b.length) throw new RangeError("eof");
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
}

/** The layout of a serialized transaction, or undefined when it is not decoded with certainty. */
export function parseTxLayout(tx: Uint8Array): TxLayout | undefined {
  try {
    const r = new Reader(tx);
    const numSignatures = r.cu16();
    const slotsOffset = r.o;
    r.take(numSignatures * 64);
    const messageOffset = r.o;
    let version: TxLayout["version"] = "legacy";
    const first = r.b[r.o];
    if (first === undefined) return undefined;
    if (first & 0x80) {
      if ((first & 0x7f) !== 0) return undefined;
      r.o++;
      version = 0;
    }
    const requiredSignatures = r.byte();
    r.byte(); // readonly signed
    r.byte(); // readonly unsigned
    const nkeys = r.cu16();
    const keys: string[] = [];
    for (let i = 0; i < nkeys; i++) keys.push(base58Encode(r.take(32)));
    r.take(32); // recent blockhash
    const nix = r.cu16();
    for (let i = 0; i < nix; i++) {
      r.byte(); // program index
      r.take(r.cu16()); // account indexes
      r.take(r.cu16()); // data
    }
    if (version === 0) {
      const nlut = r.cu16();
      for (let i = 0; i < nlut; i++) {
        r.take(32);
        r.take(r.cu16());
        r.take(r.cu16());
      }
    }
    if (r.o !== r.b.length) return undefined;
    if (requiredSignatures === 0 || requiredSignatures !== numSignatures || requiredSignatures > nkeys) return undefined;
    return { version, numSignatures, slotsOffset, messageOffset, requiredSignatures, signers: keys.slice(0, requiredSignatures) };
  } catch {
    return undefined;
  }
}

export type TxSignResult = { ok: true; signed: Uint8Array; slot: number; layout: TxLayout } | { ok: false; error: "TX_INVALID" | "TX_NOT_FOR_WALLET" };

/** Where the agent wallet signs, without signing (checked before the human is asked). */
export function agentSlot(tx: Uint8Array, address: string): { ok: true; slot: number; layout: TxLayout } | { ok: false; error: "TX_INVALID" | "TX_NOT_FOR_WALLET" } {
  const layout = parseTxLayout(tx);
  if (!layout) return { ok: false, error: "TX_INVALID" };
  const slot = layout.signers.indexOf(address);
  if (slot < 0) return { ok: false, error: "TX_NOT_FOR_WALLET" };
  return { ok: true, slot, layout };
}

/** A copy of `tx` with the agent wallet's ed25519 signature over the message in its own slot. */
export function signTransactionFor(tx: Uint8Array, signer: Signer): TxSignResult {
  const at = agentSlot(tx, signer.address);
  if (!at.ok) return at;
  const out = new Uint8Array(tx);
  const sig = signer.sign(out.subarray(at.layout.messageOffset));
  if (sig.length !== 64) return { ok: false, error: "TX_INVALID" };
  out.set(sig, at.layout.slotsOffset + at.slot * 64);
  return { ok: true, signed: out, slot: at.slot, layout: at.layout };
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict base64 → bytes (undefined for anything else). */
export function base64ToBytes(b64: string): Uint8Array | undefined {
  if (b64.length === 0 || b64.length % 4 !== 0 || !B64.test(b64)) return undefined;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
