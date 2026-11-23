/**
 * DGAJ22 test helper: a recorded Jupiter `/order` transaction (degenly src/data/fixtures, keyless, never signed)
 * re-keyed for another wallet the way Jupiter itself would build it for that wallet:
 *   - the taker's 32 key bytes → the new wallet's (the trick of degenly programs.test.ts:16-24 / botApiRoutes.test.ts:54-71);
 *   - every static key that is the taker's associated token account (ATA(taker, mint, Token | Token-2022) for a mint
 *     in the message, or wSOL) → the new wallet's ATA of the same mint / program.
 * Without the second step the SOL wrap (System Transfer taker → taker's wSOL ATA) would go to the OLD taker's account,
 * which the local check (src/tx.ts checkAgentTx) rightly refuses as a foreign transfer.
 */
import { base58Decode } from "../src/sign.js";
import { associatedTokenAddress, parseTxLayout } from "../src/tx.js";

export const FIXTURE_TAKER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
/** degenly src/data/fixtures/jupiter-swap-v2-order-metis-sol-usdc.json `transaction` (v0, 1 signer = FIXTURE_TAKER). */
export const METIS_SOL_USDC_TX =
  "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAFCEjAG1BZAFRV2dywxrzs3LT7Wy6rwamoK1c5K6qkDwTm3sTeRGTwuXxew5/kivghLMd/7RlS2oFJdI1UTmJL6wANhMFxmHie5lj8TFWhd75WFwp5jDWzhXPBOqZlIgYcLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAD80T2gQVWQE89K66GoTtcCOtT/IahHR/87Basw+oIHwwR51VvyMcBu7nTFbs5oFQf9sbLeo/SOUQKxzaJWvBOPBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKliQrk0Uv/ujdii1Gc5zV3hfsbAB4Q6ISb19XxcvSE7qAYEAAUC4NwBAAQACQOTBAAAAAAAAAMCAAIMAgAAAICWmAAAAAAABwECAREGGwACAQ8NBwcGDAYIEgALAgEJCg8NEBETBwcFDii7ZPrMMcSvFICWmAAAAAAAOK4QAAAAAAAWAAIAAAABAAAAlwAQJwABBwMCAAABCQIpv5UHKk+/BN9xdZPnOLzMIScoFcJHGoDZ+fVVsNSEJQEhBAAoARe1Dh+3xL8b+dTiI1DcM69hfXHQaeljCtwigIUwexkpUQPq7/EE8jGFLg==";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** Every occurrence of the 32 key bytes of `from` replaced by those of `to` (0 hits is fine). */
export function swapKeyBytes(tx: Uint8Array, from: string, to: string): Uint8Array {
  const a = base58Decode(from);
  const b = base58Decode(to);
  if (!a || !b || a.length !== 32 || b.length !== 32) throw new Error("bad key");
  const out = new Uint8Array(tx);
  for (let i = 0; i + 32 <= out.length; i++) if (a.every((v, j) => out[i + j] === v)) out.set(b, i);
  return out;
}

export function rekey(tx: Uint8Array, wallet: string, taker: string = FIXTURE_TAKER): Uint8Array {
  const l = parseTxLayout(tx);
  if (!l) throw new Error("fixture does not decode");
  let out = swapKeyBytes(tx, taker, wallet);
  for (const mint of new Set([...l.keys, SOL_MINT])) {
    for (const prog of TOKEN_PROGRAMS) {
      const old = associatedTokenAddress(taker, mint, prog);
      const now = associatedTokenAddress(wallet, mint, prog);
      if (old !== undefined && now !== undefined && l.keys.includes(old)) out = swapKeyBytes(out, old, now);
    }
  }
  return out;
}
