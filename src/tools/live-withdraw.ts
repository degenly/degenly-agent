/**
 * DGAJ30: SOL from the agent wallet back to the ONE main wallet it was paired with — nowhere else.
 * MCP `degenly_live_withdraw` (arguments: `amountSol` | `all`; there is NO destination argument) and CLI
 * `degenly withdraw <sol|all>` (interactive terminal only). Every answer: `mode: "live"`.
 *
 * Server contract (degenly repo, read only: src/edge/agentWithdrawApi.ts + DGAJ28 report):
 *   POST /v1/withdraw/prepare {lamports: "<decimal>" | "all"} → {ok, transaction (base64, unsigned legacy), owner, lamports, feeLamports}
 *   POST /v1/withdraw/send    {signedTransaction: "<base64>"}  → {ok, signature}
 *   404 = the withdraw flag (or the Bot API) is off.
 *
 * The destination is decided by THIS computer, not by the server: `~/.degenly/owner.json` (written by `setup` /
 * `pair --owner`). One call = one fixed path (nothing is skipped by an argument):
 *   1. amount shape (BAD_AMOUNT), agent wallet + API key, the local owner record (OWNER_UNKNOWN)   — no network
 *   2. ONE `prepare` (the body names no destination)
 *   3. the server's `owner` must equal the local record and its `lamports` the asked amount (not for "all");
 *      the transaction is decoded HERE (../tx.ts `checkWithdrawTx`): legacy only, one signer = the agent, one
 *      instruction = System Transfer, source = the agent, destination = the LOCAL owner, lamports = the server's
 *      figure. Anything off → TX_REFUSED and nothing is signed. A compromised server cannot redirect the funds.
 *   4. the HUMAN confirms. Always: DEGENLY_CONFIRM=off does NOT apply to withdrawals. MCP: the form (elicitation);
 *      a client without forms → CONFIRM_UNSUPPORTED. CLI: "Type YES to send" in an interactive terminal.
 *   5. sign the agent's slot (../tx.ts `signWithdrawFor`, which re-runs the check) → ONE `send`. NO automatic retry:
 *      a network error / timeout / 5xx answers WITHDRAW_NOT_CONFIRMED ("Not confirmed. Check the agent wallet
 *      balance before trying again.").
 * Tokens are never withdrawn (sell first; only SOL is withdrawn). The key / recovery phrase are never in a request.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer, LiveDeps } from "../cli.js";
import { DEFAULT_API_BASE } from "../client.js";
import { SOL_DECIMALS, formatUnits, parseSol } from "../demo/fill.js";
import { degenlyDir } from "../keys.js";
import { isSolanaAddress } from "../sign.js";
import { base64ToBytes, bytesToBase64, checkWithdrawTx, signWithdrawFor } from "../tx.js";
import type { Elicitor } from "./confirm.js";
import { fromServer, liveAnswer, liveError, openLive } from "./live-read.js";

// ---- the local owner record --------------------------------------------------------------------

export const OWNER_FILE_NAME = "owner.json";
export const OWNER_PATH_TEXT = "~/.degenly/owner.json";
const POSIX = process.platform !== "win32";

export function ownerPath(home: string): string {
  return join(degenlyDir(home), OWNER_FILE_NAME);
}

/** `setup` / `pair --owner`: records the main wallet (`{"v":1,"owner":"<address>"}`, 0600). Replaces an older record. */
export function saveOwner(home: string, owner: string): boolean {
  if (!isSolanaAddress(owner)) return false;
  try {
    mkdirSync(degenlyDir(home), { recursive: true, mode: 0o700 });
    if (POSIX) chmodSync(degenlyDir(home), 0o700);
    writeFileSync(ownerPath(home), JSON.stringify({ v: 1, owner }), { mode: 0o600 });
    if (POSIX) chmodSync(ownerPath(home), 0o600);
    return true;
  } catch {
    return false;
  }
}

/** The recorded main wallet, or undefined (no file, unreadable, or not a Solana address). */
export function loadOwner(home: string): string | undefined {
  const file = ownerPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const o = (v as Record<string, unknown>).owner;
    return (v as Record<string, unknown>).v === 1 && typeof o === "string" && isSolanaAddress(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

// ---- texts -------------------------------------------------------------------------------------

export const WITHDRAW_ONLY_OWNER = "Funds can only go back to your paired main wallet.";
export const WITHDRAW_SOL_ONLY = "Tokens are not withdrawn: sell first; only SOL is withdrawn.";
export const WITHDRAW_PAIRED_LINE = "This is your paired main wallet.";
export const WITHDRAW_NOT_CONFIRMED_TEXT = "Not confirmed. Check the agent wallet balance before trying again.";
export const WITHDRAW_TERMINAL_QUESTION = "Type YES to send: ";
/** The human has this long to answer (a prepared transaction's blockhash is valid for ~60-90 s). */
export const WITHDRAW_CONFIRM_TIMEOUT_MS = 60_000;
export const WITHDRAW_CONFIRM_FIELD = "confirm";

export const WITHDRAW_HINTS: Readonly<Record<string, string>> = {
  TX_REFUSED:
    "The withdrawal Degenly prepared is not exactly one SOL transfer from the agent wallet to your paired main wallet recorded on this computer (see reason). Nothing was signed or sent.",
  CANCELLED: "The withdrawal was not confirmed (declined, closed or timed out). Nothing was signed or sent.",
  CONFIRM_UNSUPPORTED:
    "This MCP client cannot show a confirmation form, so nothing was sent. A withdrawal always needs your confirmation (DEGENLY_CONFIRM=off does not apply to it). Run degenly withdraw <sol|all> yourself in your own terminal instead.",
  WITHDRAW_NOT_CONFIRMED: WITHDRAW_NOT_CONFIRMED_TEXT,
};

function withdrawError(error: string, extra: Record<string, unknown> = {}): Answer {
  const a = liveError(error, extra);
  return WITHDRAW_HINTS[error] !== undefined && extra.hint === undefined ? { ...a, hint: WITHDRAW_HINTS[error] } : a;
}

export interface WithdrawSummary {
  amountSol: string;
  feeSol: string;
  owner: string;
  apiBase: string;
}

/** DGAJ22 pattern: a non-default server is named on the FIRST line. */
export function withdrawMessage(s: WithdrawSummary): string {
  return [
    ...(s.apiBase !== DEFAULT_API_BASE ? [`WARNING: this withdrawal is prepared by ${s.apiBase}, not degenly.app.`] : []),
    "WITHDRAWAL from your agent wallet (real SOL, not demo). Check every line before you confirm.",
    `Amount: ${s.amountSol} SOL`,
    `To: ${s.owner}`,
    WITHDRAW_PAIRED_LINE,
    `Network fee: ${s.feeSol} SOL (paid by the agent wallet)`,
    `${WITHDRAW_ONLY_OWNER} ${WITHDRAW_SOL_ONLY}`,
    "Only confirm if you asked for this withdrawal.",
  ].join("\n");
}

// ---- confirmation ------------------------------------------------------------------------------

export type WithdrawConfirmOutcome = "accepted" | "declined" | "unsupported";
/** Asks the human with the summary text. Never reads DEGENLY_CONFIRM. */
export type WithdrawConfirm = (message: string) => Promise<WithdrawConfirmOutcome>;

export const WITHDRAW_CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    [WITHDRAW_CONFIRM_FIELD]: { type: "boolean" as const, title: "Send this withdrawal", description: "Tick to send this SOL from the agent wallet to your paired main wallet.", default: false },
  },
  required: [WITHDRAW_CONFIRM_FIELD],
};

/** MCP: the form. No form support → "unsupported" (nothing is sent). Any failure → "declined". */
export function elicitConfirm(elicitor: () => Elicitor | undefined): WithdrawConfirm {
  return async (message) => {
    const e = elicitor();
    if (!e || !e.supportsForm()) return "unsupported";
    try {
      const r = await e.elicit(message, WITHDRAW_CONFIRM_SCHEMA, WITHDRAW_CONFIRM_TIMEOUT_MS);
      return r.action === "accept" && r.content?.[WITHDRAW_CONFIRM_FIELD] === true ? "accepted" : "declined";
    } catch {
      return "declined";
    }
  };
}

/** CLI: the summary + "Type YES to send"; only an exact YES sends. */
export function terminalConfirm(promptLine: ((question: string) => Promise<string>) | undefined): WithdrawConfirm {
  return async (message) => {
    if (!promptLine) return "unsupported";
    try {
      const answer = await promptLine(`${message}\n\n${WITHDRAW_TERMINAL_QUESTION}`);
      return answer.trim() === "YES" ? "accepted" : "declined";
    } catch {
      return "declined";
    }
  };
}

// ---- the withdrawal ----------------------------------------------------------------------------

const UINT = /^\d+$/;

export interface LiveWithdraw {
  /** `amount` = a SOL decimal string or "all"; `confirm` = how the human is asked. */
  withdraw(amount: string, confirm: WithdrawConfirm): Promise<Answer>;
}

export function createLiveWithdraw(d: LiveDeps): LiveWithdraw {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => undefined);
    return run;
  };

  const run = async (amountArg: string, confirm: WithdrawConfirm): Promise<Answer> => {
    // 1. inputs + local files (no network)
    const all = amountArg.trim().toLowerCase() === "all";
    const wanted = all ? undefined : parseSol(amountArg);
    if (!all && wanted === undefined) return liveError("BAD_AMOUNT");
    const o = openLive(d);
    if (!o.ok) return liveError(o.error, { missing: o.missing });
    const ctx = o.ctx;
    const owner = loadOwner(d.home);
    if (owner === undefined) return liveError("OWNER_UNKNOWN");
    if (owner === ctx.wallet.address) return liveError("BAD_OWNER");

    // 2. ONE prepare; the body never names a destination
    const p = await ctx.client.request("POST", "/v1/withdraw/prepare", JSON.stringify({ lamports: all ? "all" : (wanted ?? 0n).toString() }));
    if (!p.ok) return p.error === "NOT_FOUND" ? liveError("WITHDRAW_NOT_AVAILABLE") : fromServer(p);
    const txB64 = p.data.transaction;
    const srvOwner = p.data.owner;
    const srvLamports = p.data.lamports;
    const srvFee = p.data.feeLamports;
    if (typeof txB64 !== "string" || typeof srvOwner !== "string" || typeof srvLamports !== "string" || !UINT.test(srvLamports) || typeof srvFee !== "string" || !UINT.test(srvFee)) {
      return liveError("BAD_RESPONSE");
    }
    const bytes = base64ToBytes(txB64);
    if (!bytes) return withdrawError("TX_REFUSED", { reason: "malformed" });

    // 3. the local check: the destination is the LOCAL record, and it must also be what the server says
    if (srvOwner !== owner) return withdrawError("TX_REFUSED", { reason: "destination", ownerOnThisComputer: owner });
    const lamports = BigInt(srvLamports);
    if (wanted !== undefined && lamports !== wanted) return withdrawError("TX_REFUSED", { reason: "amount" });
    const checked = checkWithdrawTx(bytes, ctx.wallet.address, owner);
    if (!checked.ok) return withdrawError("TX_REFUSED", { reason: checked.reason });
    if (checked.lamports !== lamports) return withdrawError("TX_REFUSED", { reason: "amount" });

    // 4. the human confirms (always)
    const amountSol = formatUnits(lamports, SOL_DECIMALS);
    const facts = { amountSol, to: owner };
    const outcome = await confirm(withdrawMessage({ amountSol, feeSol: formatUnits(BigInt(srvFee), SOL_DECIMALS), owner, apiBase: ctx.base }));
    if (outcome === "unsupported") return withdrawError("CONFIRM_UNSUPPORTED", facts);
    if (outcome !== "accepted") return withdrawError("CANCELLED", facts);

    // 5. sign the agent's slot (the check runs again inside) + ONE send, no retry
    const signed = signWithdrawFor(bytes, ctx.wallet, owner, lamports);
    if (!signed.ok) return withdrawError("TX_REFUSED", { reason: signed.reason });
    const s = await ctx.client.request("POST", "/v1/withdraw/send", JSON.stringify({ signedTransaction: bytesToBase64(signed.signed) }));
    if (!s.ok) {
      if (s.error === "NETWORK" || s.status >= 500) return withdrawError("WITHDRAW_NOT_CONFIRMED", { ...facts, ...(s.error !== "NETWORK" ? { serverError: s.error, status: s.status } : {}) });
      if (s.error === "NOT_FOUND") return liveError("WITHDRAW_NOT_AVAILABLE");
      return fromServer(s);
    }
    const signature = typeof s.data.signature === "string" ? s.data.signature : undefined;
    if (signature === undefined) return withdrawError("WITHDRAW_NOT_CONFIRMED", facts);
    return liveAnswer({ status: "sent", ...facts, txSignature: signature });
  };

  return { withdraw: (amount, confirm) => serial(() => run(amount, confirm)) };
}
