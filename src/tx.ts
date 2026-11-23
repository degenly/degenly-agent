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
 *
 * DGAJ22 (security audit DGAJ14 E-1): the quote comes from whatever DEGENLY_API_BASE points at, so the package no
 * longer trusts it. `checkAgentTx` runs BEFORE the human is asked and again inside `signTransactionFor`; a refusal
 * means nothing is signed. It is a copy of the degenly repo's own rules (read only):
 *   (a) every invoked program ∈ ALLOWED_PROGRAMS                     (degenly/src/swap/programs.ts:27-35, :117-127)
 *   (b) a program id behind an address-lookup table → TX_INVALID      (programs.ts:123-124; signPolicy.ts:238-239)
 *   (c) what leaves the agent wallet (System Transfer / CreateAccount(+WithSeed), Token Transfer(Checked) with the
 *       agent as authority, CloseAccount owned by the agent, ATA creation paid by the agent) may only go to the
 *       agent itself / an account the agent owns; everything else that touches the agent wallet is refused.
 *       = the standard GF5 policy `checkStandardTx` (degenly/src/swap/signPolicy.ts:530-674) with the swap context
 *       of the server (`feeRecipient: undefined`, embeddedSigner.gf5.test.ts:113-118): NO fee / tip destination
 *       is allowed; the Jupiter Trigger co-signer and the in-app withdraw exceptions are NOT copied (no swap uses
 *       them), so this is stricter than the site, never looser.
 * Limit (stated, not hidden): a Jupiter program instruction is opaque here, exactly as on the server
 * (signPolicy.ts:67-71). A bad route through an allowed program is NOT caught.
 */
import { createHash } from "node:crypto";
import { base58Decode, base58Encode, type Signer } from "./sign.js";

// ---- (a) program allow-list ------------------------------------------------------------------------

/**
 * Must be the same set as `ALLOWED_PROGRAMS` in the degenly repo, src/swap/programs.ts:27-35 (7 programs; the site
 * labels both Jupiter ids "Jupiter"). Dflow / OKX routers are not listed there either.
 */
export const ALLOWED_PROGRAMS: readonly { readonly name: string; readonly id: string }[] = [
  { name: "Compute Budget", id: "ComputeBudget111111111111111111111111111111" }, // programs.ts:28
  { name: "System", id: "11111111111111111111111111111111" }, // programs.ts:29
  { name: "Token", id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, // programs.ts:30
  { name: "Token-2022", id: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, // programs.ts:31
  { name: "Associated Token Account", id: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" }, // programs.ts:32
  { name: "Jupiter", id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" }, // programs.ts:33
  { name: "Jupiter RFQ", id: "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH" }, // programs.ts:34
];
const ALLOWED = new Set(ALLOWED_PROGRAMS.map((p) => p.id));

// same constants as degenly/src/swap/signPolicy.ts:82-86
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** degenly/src/config/constants.ts:629 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** degenly/src/config/constants.ts:1850 `ORDER_DEPOSIT_RENT_MAX_LAMPORTS` */
const RENT_MAX_LAMPORTS = 2_500_000n;

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
  /** DGAJ22: the static account keys of the message, in order */
  keys: string[];
  /** DGAJ22: the instructions as written (indexes into the static keys; an index ≥ keys.length is a lookup-table account) */
  instructions: RawIx[];
}

export interface RawIx {
  programIndex: number;
  accounts: number[];
  data: Uint8Array;
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
    const instructions: RawIx[] = [];
    for (let i = 0; i < nix; i++) {
      const programIndex = r.byte();
      const accounts = [...r.take(r.cu16())];
      instructions.push({ programIndex, accounts, data: r.take(r.cu16()) });
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
    return { version, numSignatures, slotsOffset, messageOffset, requiredSignatures, signers: keys.slice(0, requiredSignatures), keys, instructions };
  } catch {
    return undefined;
  }
}

export type TxCheckError = "TX_INVALID" | "TX_NOT_FOR_WALLET" | "TX_PROGRAM_NOT_ALLOWED" | "TX_UNEXPECTED_TRANSFER" | "TX_INSTRUCTION_NOT_ALLOWED";
export type TxCheckResult = { ok: true; slot: number; layout: TxLayout } | { ok: false; error: TxCheckError };
export type TxSignResult = { ok: true; signed: Uint8Array; slot: number; layout: TxLayout } | { ok: false; error: TxCheckError };

/** Where the agent wallet signs, without signing (layout + signer only; the full check is `checkAgentTx`). */
export function agentSlot(tx: Uint8Array, address: string): { ok: true; slot: number; layout: TxLayout } | { ok: false; error: "TX_INVALID" | "TX_NOT_FOR_WALLET" } {
  const layout = parseTxLayout(tx);
  if (!layout) return { ok: false, error: "TX_INVALID" };
  const slot = layout.signers.indexOf(address);
  if (slot < 0) return { ok: false, error: "TX_NOT_FOR_WALLET" };
  return { ok: true, slot, layout };
}

// ---- PDA / ATA (sync copy of degenly/src/data/helius.ts:182-237 + signPolicy.ts:262-277) -------------

const P = (1n << 255n) - 19n;
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const D = (((-121665n * modPow(121666n, P - 2n, P)) % P) + P) % P;

/** ed25519 point decompression check (helius.ts:200-212, the rule Solana's `is_on_curve` uses). */
function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  y &= (1n << 255n) - 1n;
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const ratio = (u * modPow(v, P - 2n, P)) % P;
  if (ratio === 0n) return true;
  return modPow(ratio, (P - 1n) / 2n, P) === 1n;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** Solana `find_program_address` (helius.ts:229-237). */
function findProgramAddress(seeds: readonly Uint8Array[], programId: string): string | undefined {
  const program = base58Decode(programId);
  if (!program || program.length !== 32) return undefined;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(program).update(PDA_MARKER);
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return base58Encode(out);
  }
  return undefined;
}

/** ATA(owner, mint) under `tokenProgram` (Solana `get_associated_token_address`); undefined on a bad key. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): string | undefined {
  const o = base58Decode(owner);
  const m = base58Decode(mint);
  const p = base58Decode(tokenProgram);
  if (!o || !m || !p || o.length !== 32 || m.length !== 32 || p.length !== 32) return undefined;
  return findProgramAddress([o, p, m], ATA_PROGRAM);
}

/** The agent's ATAs of `mints` + wSOL under Token and Token-2022 (signPolicy.ts:262-277 `userAtas`). */
function agentAtas(agent: string, mints: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const m of new Set([...mints, SOL_MINT])) {
    for (const prog of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const a = associatedTokenAddress(agent, m, prog);
      if (a) out.add(a);
    }
  }
  return out;
}

function u32(d: Uint8Array, off: number): number | undefined {
  if (off + 4 > d.length) return undefined;
  return ((d[off] ?? 0) | ((d[off + 1] ?? 0) << 8) | ((d[off + 2] ?? 0) << 16)) + (d[off + 3] ?? 0) * 0x1000000;
}
function u64(d: Uint8Array, off: number): bigint | undefined {
  if (off + 8 > d.length) return undefined;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[off + i] ?? 0);
  return v;
}
function keyAt(d: Uint8Array, off: number): string | undefined {
  return off + 32 <= d.length ? base58Encode(d.subarray(off, off + 32)) : undefined;
}

// ---- the check ------------------------------------------------------------------------------------

/**
 * DGAJ22: may the agent wallet sign this quoted transaction? Pure, no network. Order:
 * layout (TX_INVALID) → agent among the signers (TX_NOT_FOR_WALLET) → no program id behind a lookup table
 * (TX_INVALID, signPolicy.ts:239) → every program allowed (TX_PROGRAM_NOT_ALLOWED, programs.ts:126 / signPolicy.ts:533)
 * → the GF5 standard policy for the agent (signPolicy.ts:537-673, swap context, no exception):
 *   value to a foreign account → TX_UNEXPECTED_TRANSFER; any other instruction kind with the agent → TX_INSTRUCTION_NOT_ALLOWED.
 */
export function checkAgentTx(tx: Uint8Array, agent: string): TxCheckResult {
  const at = agentSlot(tx, agent);
  if (!at.ok) return at;
  const { keys, instructions } = at.layout;
  const ixs: { programId: string; accounts: string[]; data: Uint8Array }[] = [];
  for (const ix of instructions) {
    const programId = keys[ix.programIndex];
    if (programId === undefined) return { ok: false, error: "TX_INVALID" }; // invoked program behind a lookup table
    // an account index past the static keys is a lookup-table address: never the agent (a signer is always static)
    ixs.push({ programId, accounts: ix.accounts.map((a) => keys[a] ?? `lut#${a}`), data: ix.data });
  }
  if (ixs.length === 0) return { ok: false, error: "TX_INVALID" }; // programs.ts:150 `programs.length > 0`
  for (const ix of ixs) if (!ALLOWED.has(ix.programId)) return { ok: false, error: "TX_PROGRAM_NOT_ALLOWED" };

  const refuse = (error: TxCheckError): TxCheckResult => ({ ok: false, error });

  // Pass 1: ownership facts established by THIS tx (signPolicy.ts:542-566; the ATA program enforces ata = ATA(owner, mint)).
  const owner = new Map<string, string>();
  const mints = new Set<string>();
  for (const ix of ixs) {
    const a = ix.accounts;
    if (ix.programId === ATA_PROGRAM && a[1] !== undefined && a[2] !== undefined) {
      owner.set(a[1], a[2]);
      if (a[3] !== undefined) mints.add(a[3]);
    }
    if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
      const op = ix.data[0];
      const o18 = op === 18 && ix.data.length === 33 ? keyAt(ix.data, 1) : undefined; // InitializeAccount3
      const o16 = op === 16 && ix.data.length === 33 ? keyAt(ix.data, 1) : undefined; // InitializeAccount2
      const o1 = op === 1 && ix.data.length === 1 ? a[2] : undefined; // InitializeAccount [acct, mint, owner, rent]
      const o = o18 ?? o16 ?? o1;
      if (o !== undefined && a[0] !== undefined) owner.set(a[0], o);
      if (op === 12 && a[1] !== undefined) mints.add(a[1]);
    }
  }
  const atas = agentAtas(agent, mints);
  // The site's `trusted` minus the Jupiter Trigger co-signer owners (no swap has that co-signer): own accounts only.
  const own = (acct: string | undefined): boolean => acct !== undefined && (acct === agent || atas.has(acct) || owner.get(acct) === agent);

  // Pass 2 (signPolicy.ts:579-665)
  for (const ix of ixs) {
    const a = ix.accounts;
    const data = ix.data;
    if (ix.programId === COMPUTE_BUDGET_PROGRAM) {
      if ((data[0] === 2 && data.length === 5) || (data[0] === 3 && data.length === 9) || (data[0] === 1 && data.length === 5)) continue;
      return refuse("TX_INSTRUCTION_NOT_ALLOWED");
    }
    // Jupiter programs: opaque, allow-listed (the server's limit too, signPolicy.ts:67-71, :587-588).
    if (ix.programId !== SYSTEM_PROGRAM && ix.programId !== TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM && ix.programId !== ATA_PROGRAM) continue;
    // An instruction that does not list the agent cannot spend the agent's funds.
    if (!a.includes(agent)) continue;

    if (ix.programId === SYSTEM_PROGRAM) {
      const kind = u32(data, 0);
      if (kind === 2 && data.length === 12) {
        // Transfer [from, to]
        if (u64(data, 4) === undefined || a[1] === undefined) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        if (a[0] !== agent) continue; // into the agent
        if (own(a[1])) continue; // e.g. SOL wrapped into the agent's own wSOL account
        return refuse("TX_UNEXPECTED_TRANSFER"); // no fee / tip destination in a swap (feeRecipient undefined)
      }
      if (kind === 0 && data.length === 52) {
        // CreateAccount [funder, new]: lamports u64 @4, space u64 @12, owner @20
        if (a[0] !== agent) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        const lamports = u64(data, 4);
        const prog = keyAt(data, 20);
        if (lamports === undefined || (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022_PROGRAM)) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        if (!own(a[1]) || lamports > RENT_MAX_LAMPORTS) return refuse("TX_UNEXPECTED_TRANSFER");
        continue;
      }
      if (kind === 3) {
        // CreateAccountWithSeed [funder, new, base]: base(32) | seedLen(u64) | seed | lamports | space | owner
        if (a[0] !== agent) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        const seedLen = u64(data, 36);
        if (seedLen === undefined || seedLen > 32n) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        const off = 44 + Number(seedLen);
        const lamports = u64(data, off);
        const prog = keyAt(data, off + 16);
        if (lamports === undefined || data.length !== off + 48 || (prog !== TOKEN_PROGRAM && prog !== TOKEN_2022_PROGRAM)) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
        if (!own(a[1]) || lamports > RENT_MAX_LAMPORTS) return refuse("TX_UNEXPECTED_TRANSFER");
        continue;
      }
      // TransferWithSeed [from(derived), base = agent, to]: value moved by the agent's signature, never in a swap
      if (kind === 11) return refuse("TX_UNEXPECTED_TRANSFER");
      // Assign, Allocate, nonce … never with the agent (the server: INSTRUCTION_NOT_ALLOWED, signPolicy.ts:631)
      return refuse("TX_INSTRUCTION_NOT_ALLOWED");
    }

    if (ix.programId === ATA_PROGRAM) {
      // Create / CreateIdempotent [payer, ata, owner, mint, system, token]
      if (!(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) return refuse("TX_INSTRUCTION_NOT_ALLOWED");
      if (a[0] === agent && a[2] !== agent) return refuse("TX_UNEXPECTED_TRANSFER"); // the agent pays rent for someone else's ATA
      continue;
    }

    // Token / Token-2022
    const op = data[0];
    if (op === 3 && data.length === 9) {
      // Transfer [source, dest, authority]
      if (a[2] !== agent) continue;
      if (!own(a[1])) return refuse("TX_UNEXPECTED_TRANSFER");
      continue;
    }
    if (op === 12 && data.length === 10) {
      // TransferChecked [source, mint, dest, authority]
      if (a[3] !== agent) continue;
      if (!own(a[2])) return refuse("TX_UNEXPECTED_TRANSFER");
      continue;
    }
    if (op === 9 && data.length === 1) {
      // CloseAccount [account, destination, owner]: the rent goes back to the agent
      if (a[2] !== agent) continue;
      if (!own(a[1])) return refuse("TX_UNEXPECTED_TRANSFER");
      continue;
    }
    if ((op === 17 && data.length === 1) || (op === 5 && data.length === 1)) continue; // SyncNative, Revoke
    if ((op === 18 || op === 16) && data.length === 33) continue; // InitializeAccount3 / 2 (owner recorded above)
    if (op === 1 && data.length === 1) continue; // InitializeAccount
    return refuse("TX_INSTRUCTION_NOT_ALLOWED"); // Approve, SetAuthority, Burn, Freeze …
  }
  return at;
}

/** A copy of `tx` with the agent wallet's ed25519 signature over the message in its own slot (only after `checkAgentTx`). */
export function signTransactionFor(tx: Uint8Array, signer: Signer): TxSignResult {
  const at = checkAgentTx(tx, signer.address);
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
