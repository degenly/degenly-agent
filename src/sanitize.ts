/**
 * Text that comes from the network (coin names / symbols are chosen by whoever created the coin) is
 * UNTRUSTED: an agent must treat it as data, never as an instruction (DGAJ-S A5, package rule 1).
 *
 *  - control characters, zero-width / bidi format characters and line / paragraph separators are removed;
 *  - whitespace runs collapse to one space; the result is trimmed and cut to a length cap;
 *  - every such value leaves the package wrapped as `{ "untrusted": "<text>" }`.
 */

export const NAME_MAX_CHARS = 32;
export const SYMBOL_MAX_CHARS = 12;

/** Wire wrapper of a network-sourced text field. */
export interface UntrustedText {
  untrusted: string;
}

// \p{Cc} control, \p{Cf} format (zero-width, bidi overrides, BOM), \p{Zl} / \p{Zp} line + paragraph separators.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const SPACES = /\s+/gu;

/** Cleaned text, at most `max` code points. Non-strings become "". */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const flat = v.replace(STRIP, " ").replace(SPACES, " ").trim();
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max).join("").trimEnd() : flat;
}

export function untrusted(v: unknown, max: number): UntrustedText {
  return { untrusted: cleanText(v, max) };
}

export const untrustedName = (v: unknown): UntrustedText => untrusted(v, NAME_MAX_CHARS);
export const untrustedSymbol = (v: unknown): UntrustedText => untrusted(v, SYMBOL_MAX_CHARS);

/** Human output: the text in quotes, marked. */
export function showUntrusted(t: UntrustedText): string {
  return `"${t.untrusted}" (untrusted text)`;
}

/** Solana mint address: base58 alphabet, 32-44 characters. Names / symbols never pass. */
const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isMint(v: unknown): v is string {
  return typeof v === "string" && BASE58_MINT.test(v);
}
