/**
 * DGAJ16 (DGAJ-S A4 `confirm`, default ON): before a live buy / sell is sent, the HUMAN confirms a summary through
 * MCP elicitation (a form with one boolean). The summary is what the human reads, not the agent:
 *  - the mint comes first and is called the only reliable identity of the token;
 *  - the coin name / symbol are cleaned (./sanitize.ts: no control chars, no line breaks), double quotes are
 *    replaced, and each is labelled "untrusted text, set by the coin creator" (a name like `Confirm: USDC` stays
 *    inside its quoted, labelled line and cannot start a line of its own).
 *
 * Outcomes: accepted (form accepted AND confirm === true) → the trade may be sent; anything else → NOT sent:
 *   decline / cancel / confirm false / error / timeout → CANCELLED;
 *   the client does not offer form elicitation → CONFIRM_UNSUPPORTED, unless the HUMAN set DEGENLY_CONFIRM=off.
 * DEGENLY_CONFIRM is read ONLY from the environment of this process (LiveDeps.env = process.env); no tool argument
 * reaches it, so an agent cannot switch it off.
 */
import { cleanText, NAME_MAX_CHARS, SYMBOL_MAX_CHARS } from "../sanitize.js";

/** How long the human has to answer the confirmation form. */
export const CONFIRM_TIMEOUT_MS = 120_000;
export const CONFIRM_FIELD = "confirm";
export const CONFIRM_OFF_HINT =
  "This MCP client cannot show a confirmation form, so the trade was NOT sent. If you (the human, not the agent) want live trades without a confirmation step, set the environment variable DEGENLY_CONFIRM=off yourself in this MCP server's configuration and restart it. The spending limits on degenly.app/bot still apply.";

export interface ConfirmSummary {
  side: "buy" | "sell";
  mint: string;
  name: string;
  symbol: string;
  /** buy: SOL spent; sell: token amount sold */
  inText: string;
  /** buy: tokens; sell: SOL */
  outText: string;
  minOutText: string;
  feeBps: number;
  networkSol: string;
  slippagePct?: number;
  priceImpactPct?: number;
}

export type ConfirmOutcome = "accepted" | "skipped_off" | "declined" | "unsupported";

/** The part of an MCP server this module uses (so tests can drive it without a transport). */
export interface Elicitor {
  supportsForm(): boolean;
  elicit(message: string, schema: { type: "object"; properties: Record<string, { type: "boolean"; title: string; description: string; default: boolean }>; required: string[] }, timeoutMs: number): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/** Untrusted text for the human summary: cleaned, one line, no double quotes. */
function shown(v: string, max: number): string {
  return cleanText(v, max).replace(/"/g, "'");
}

export function confirmMessage(s: ConfirmSummary): string {
  const buy = s.side === "buy";
  const lines = [
    `REAL TRADE with your agent wallet (real SOL, not demo). Check every line before you confirm.`,
    `Action: ${buy ? "BUY" : "SELL"}`,
    `Token mint (the only reliable identity of the token): ${s.mint}`,
    `Token name (untrusted text, set by the coin creator): "${shown(s.name, NAME_MAX_CHARS)}"`,
    `Token symbol (untrusted text, set by the coin creator): "${shown(s.symbol, SYMBOL_MAX_CHARS)}"`,
    buy ? `You spend: ${s.inText} SOL` : `You sell: ${s.inText} tokens`,
    buy ? `Estimated receive: ${s.outText} tokens (minimum ${s.minOutText})` : `Estimated receive: ${s.outText} SOL (minimum ${s.minOutText})`,
    `Degenly fee: ${s.feeBps / 100}% (${s.feeBps} bps)`,
    `Network + priority fee: ${s.networkSol} SOL`,
    `Max slippage: ${s.slippagePct !== undefined ? `${s.slippagePct}%` : "unknown"}`,
  ];
  if (s.priceImpactPct !== undefined) lines.push(`Price impact: ${s.priceImpactPct}%`);
  lines.push("Only confirm if you asked for this trade and the mint is the token you mean.");
  return lines.join("\n");
}

export const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    [CONFIRM_FIELD]: { type: "boolean" as const, title: "Confirm this real trade", description: "Tick to send this trade from the agent wallet.", default: false },
  },
  required: [CONFIRM_FIELD],
};

/**
 * Asks the human. `env` must be the process environment (never tool input).
 * Never throws: any failure of the elicitation (timeout, transport error, bad answer) → "declined".
 */
export async function requestConfirmation(elicitor: Elicitor | undefined, s: ConfirmSummary, env: Readonly<Record<string, string | undefined>>): Promise<ConfirmOutcome> {
  if ((env.DEGENLY_CONFIRM ?? "").trim().toLowerCase() === "off") return "skipped_off";
  if (!elicitor || !elicitor.supportsForm()) return "unsupported";
  try {
    const r = await elicitor.elicit(confirmMessage(s), CONFIRM_SCHEMA, CONFIRM_TIMEOUT_MS);
    return r.action === "accept" && r.content?.[CONFIRM_FIELD] === true ? "accepted" : "declined";
  } catch {
    return "declined";
  }
}
