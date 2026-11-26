# @degenly/agent

[![degenly/degenly-agent MCP server](https://glama.ai/mcp/servers/degenly/degenly-agent/badges/score.svg)](https://glama.ai/mcp/servers/degenly/degenly-agent)

Degenly for AI agents: one package with an MCP server, a CLI and a `SKILL.md`.
Your AI app (Claude Code, Gemini CLI, Cursor, Claude Desktop) uses it to look up Solana tokens and trade them on Degenly.
Demo mode needs nothing; live mode uses a separate agent wallet whose key is created and kept on your computer.

Works with Claude Code, Cursor, Gemini CLI and Claude Desktop. Client setup: [docs/clients.md](docs/clients.md).

Live mode trades real SOL from the agent wallet after the 3 setup steps below; every live buy / sell asks for your confirmation first (on by default).
Spending limits apply to trades made through Degenly. An agent that can read files on this computer could read the agent wallet key and move funds outside Degenly. Fund the agent wallet with only what you can afford to lose.

## Demo mode

10 demo SOL, live Degenly prices, no wallet, no key, no account, no browser step.
The demo record lives only on your computer in `~/.degenly/demo.json`; nothing about it is sent to Degenly.

One command, no wallet: `npx -y @degenly/agent@0.2.1 demo status --json`

## Live mode setup (3 steps)

1. `npx -y @degenly/agent@0.2.1 setup --owner <main wallet address>`: creates the agent wallet on this computer
   (`~/.degenly/agent-wallet.json`) and prints its address and a pairing code (valid 10 minutes, once).
2. On degenly.app open `/bot`, sign in with your main wallet, choose "Pair agent" and paste the pairing code.
   The site shows an API key once. Fund the agent wallet with SOL only with what you can afford to lose.
3. `npx -y @degenly/agent@0.2.1 login --key-file <path>`: stores the API key in `~/.degenly/credentials.json`
   (or pipe the key on stdin to `login`; the key is never taken as a command argument).

Check it: `npx -y @degenly/agent@0.2.1 whoami`. A new pairing code for the same wallet:
`npx -y @degenly/agent@0.2.1 pair --owner <main wallet address>` (`setup` never overwrites an existing wallet).

## Withdraw (SOL back to your main wallet)

Funds can only go back to your paired main wallet. There is no other destination: no command or tool takes an
address. `setup` / `pair --owner` record that main wallet on this computer (`~/.degenly/owner.json`); the package
signs only a transaction that sends SOL from the agent wallet to exactly that address, even if the server says
otherwise. Tokens are not withdrawn: sell first; only SOL is withdrawn.

- `degenly withdraw <sol|all>`: run it yourself in your own terminal. It shows the amount and the full destination
  address and asks you to type YES. It refuses without an interactive terminal or with `--json`
  (`WITHDRAW_NEEDS_TERMINAL`).
- An agent uses the MCP tool `degenly_live_withdraw` (`amountSol` or `all`), which always shows you a confirmation
  form. `DEGENLY_CONFIRM=off` does not apply to withdrawals.
- A wallet set up before withdrawals existed answers `OWNER_UNKNOWN`: run `degenly pair --owner <main wallet address>`
  once to record it (no new pairing is needed just to record it).
- No automatic retry: if the answer is `WITHDRAW_NOT_CONFIRMED`, check the agent wallet balance before trying again.

## Recovery phrase (12 words)

`setup` makes the agent wallet from a standard 12-word recovery phrase (BIP39, path `m/44'/501'/0'/0'`, the
Phantom / Solflare default: "Import recovery phrase" there opens the same address). The phrase is made and kept only
on this computer (`~/.degenly/recovery.json`). Degenly never sees or stores your recovery phrase: it is never sent,
logged or printed by `setup`.

Use this phrase only for the agent wallet. Do not add accounts to it or use it as your main wallet: anyone who reads ~/.degenly/recovery.json gets every account of this phrase.
After you wrote the words down, delete recovery.json with `degenly recovery-phrase` (type DELETE).

- `degenly recovery-phrase`: shows the 12 words. Run it yourself in your own terminal and write them down on paper.
  It then asks you to type `DELETE` to remove `~/.degenly/recovery.json` (only an exact `DELETE` deletes it; anything
  else keeps it). `~/.degenly/agent-wallet.json` stays and the agent wallet keeps working; afterwards your written
  copy is the only one and `degenly recovery-phrase` no longer shows words.
  It refuses to show them to an agent (no interactive terminal, `--json`, or inside the MCP server:
  `RECOVERY_NEEDS_TERMINAL`). Wallets made before recovery phrases existed answer `NO_RECOVERY_PHRASE`: back up
  `~/.degenly/agent-wallet.json`, or withdraw and run setup again.
- `degenly recover --phrase-file <path>` (or the words piped on stdin to `degenly recover`): rebuilds the agent
  wallet on a new computer. The words are never taken as a command argument. It never overwrites an existing
  agent wallet (`WALLET_EXISTS`) and prints only the address. It writes `~/.degenly/recovery.json` again: delete it
  with `degenly recovery-phrase` (type DELETE).

Anyone with the phrase can take the agent wallet's funds; never paste it into a chat or give it to an agent.

## Add Degenly to your AI app (one line per client)

- Claude Code: `claude mcp add degenly -- npx -y @degenly/agent@0.2.1`
- Gemini CLI: `gemini mcp add degenly npx -y @degenly/agent@0.2.1`
- Cursor (`mcp.json`) / Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "degenly": { "command": "npx", "args": ["-y", "@degenly/agent@0.2.1"] } } }
```

ChatGPT does not support local MCP servers, so it cannot use this package. The Gemini web app: not verified.
Per-client details and how each one shows the confirmation step: [docs/clients.md](docs/clients.md).

Without arguments (or with `mcp`) the package starts the MCP stdio server. With a command it is the CLI.
Agent instructions: [SKILL.md](SKILL.md).

## Safety

Spending limits apply to trades made through Degenly. An agent that can read files on this computer could read the agent wallet key and move funds outside Degenly. Fund the agent wallet with only what you can afford to lose.

- **Spending limits** (per trade and per day) are set only on degenly.app: `/bot` → "Spending limits", signed in
  with your main wallet. No tool or command of this package can change them. The package also checks them on this
  computer before a buy is sent (second layer); the limit on Degenly's side is the real one. Sells are not limited.
- **Every live buy / sell is confirmed by you** in a form your AI app shows (MCP elicitation), on by default. The
  agent cannot switch it off. If your app cannot show the form, the trade is not sent; only you can set
  `DEGENLY_CONFIRM=off` in this MCP server's configuration.
- **Claude Code:** add a deny rule so Claude Code's file tools cannot read the agent wallet folder, in
  `~/.claude/settings.json`:

```json
{ "permissions": { "deny": ["Read(~/.degenly/**)"] } }
```

  This is an extra layer, not full protection: the Read rule does not cover Bash commands in general. It applies to
  Claude Code's built-in file tools and to some shell commands Claude Code recognizes, but not to a command that
  reads files without naming them, such as `grep -r` (see the "Read and Edit" warning in the
  [Claude Code permissions docs](https://code.claude.com/docs/en/permissions)).
  An equivalent rule for Cursor or Gemini CLI is not verified.
- The key file is kept in your home folder (`~/.degenly/`), never in a project folder. Do not ask an agent to read,
  print, copy or move it. The same holds for `~/.degenly/recovery.json`: an agent that can read files can read it.

## Tools / commands

Demo (demo SOL only, every answer `"mode":"demo"` and `"note":"Demo trade. No real funds moved."`):

| MCP tool | CLI | |
|---|---|---|
| `degenly_status` | `degenly demo status` | demo balance, positions, realized P&L |
| `degenly_quote` | `degenly demo quote <mint> buy <sol>` / `degenly demo quote <mint> sell <amount\|N%\|all>` | live price only |
| `degenly_buy` | `degenly demo buy <mint> <sol>` | demo buy at the live price |
| `degenly_sell` | `degenly demo sell <mint> <N%\|all>` | demo sell at the live price |
| `degenly_trades` | `degenly demo trades [--limit N]` | demo history, newest first |
| `degenly_reset` | `degenly demo reset` | back to 10 demo SOL |
| `degenly_token` | `degenly token <mint>` | name / symbol (untrusted), decimals, price, authorities |
| `degenly_search` | `degenly search <text>` | find mints by name or symbol |
| `degenly_trending` | `degenly trending [5m\|1h\|6h\|24h] [--limit N]` | most traded on Degenly |

Live (the agent wallet, every answer `"mode":"live"`; listed by the MCP server only after setup + pairing + login,
except `degenly_live_whoami`, which says what is missing):

| MCP tool | CLI | |
|---|---|---|
| `degenly_live_whoami` | `degenly whoami` | agent wallet + API key check, confirm setting, spending limit |
| `degenly_live_token` | | token facts by mint (name / symbol untrusted) |
| `degenly_live_price` | | USD price by mint |
| `degenly_live_holdings` | `degenly live holdings` | real balances of the agent wallet |
| `degenly_live_ledger` | `degenly live ledger [--limit N]` | confirmed Degenly trades of the agent wallet |
| `degenly_live_quote` | `degenly live quote <mint> buy <sol>` / `degenly live quote <mint> sell <N%\|all>` | real quote, nothing signed or sent |
| `degenly_live_buy` | (MCP only) | buy by mint; you confirm first |
| `degenly_live_sell` | (MCP only) | sell by mint; you confirm first |
| `degenly_live_withdraw` | `degenly withdraw <sol\|all>` | SOL back to your paired main wallet only; you always confirm |

Add `--json` to any CLI command for one-line JSON. Mint addresses only; names and symbols are refused.

## Error codes

Errors: non-zero exit (0 ok, 2 usage, 3 rate limited, 4 network / Degenly, 1 other) and
`{"ok":false,"error":"CODE","hint":"..."}`. The `hint` says what to do.

| error | meaning |
|---|---|
| `MINT_REQUIRED` | a name / symbol / bad address was passed instead of a mint |
| `BAD_AMOUNT` / `BAD_PERCENT` / `BAD_ARGS` / `UNKNOWN_COMMAND` | wrong amount, percent, arguments or command |
| `LOW_SOL` / `NO_HOLD` | demo: not enough demo SOL / no demo position |
| `RATE_LIMITED` | wait `retryAfterMs`, then retry |
| `NETWORK` / `BAD_RESPONSE` | Degenly unreachable or unexpected answer |
| `NOT_FOUND` | the Bot API answered 404 (off right now): nothing was sent; demo mode still works |
| `NO_WALLET` / `NOT_LOGGED_IN` / `LIVE_NOT_READY` | run setup, pair on degenly.app/bot, then login |
| `WALLET_EXISTS` | an agent wallet exists and is never overwritten; use `pair` for a new code |
| `RECOVERY_NEEDS_TERMINAL` / `NO_RECOVERY_PHRASE` | the phrase is shown only to you in your own terminal / this wallet predates recovery phrases |
| `PHRASE_ARG_REFUSED` / `PHRASE_WORD_COUNT` / `PHRASE_UNKNOWN_WORD` / `PHRASE_CHECKSUM` | `recover`: use stdin or `--phrase-file`; 12 valid words in the right order |
| `KEY_ARG_REFUSED` | the API key was given as an argument; use stdin or `--key-file` |
| `KEY_INVALID` / `KEY_WALLET_MISMATCH` | unknown / revoked key, or a key of another wallet: pair again |
| `SPEND_LIMIT` / `SPEND_LIMIT_NOT_SET` / `LOCAL_SPEND_LIMIT` / `LOCAL_LIMIT_UNKNOWN` | refused by the spending limit (or no limit known): nothing sent |
| `TOKEN_BLOCKED` | Degenly does not allow buying this token through the API |
| `CANCELLED` / `CONFIRM_UNSUPPORTED` | you did not confirm, or the app cannot show the form: nothing sent |
| `TRADING_DISABLED` / `TRADE_FAILED` | trading is off, or the trade did not complete |
| `EXECUTE_OUTCOME_UNKNOWN` | sent, no answer: do NOT retry; check holdings and ledger first |
| `OWNER_UNKNOWN` | withdraw: no main wallet recorded on this computer; run `pair --owner` once |
| `WITHDRAW_NEEDS_TERMINAL` / `WITHDRAW_NOT_AVAILABLE` | withdraw: run it in your own terminal / not switched on on this server |
| `TX_REFUSED` | withdraw: the prepared transaction was not exactly SOL to your paired main wallet; nothing signed |
| `WITHDRAW_NOT_CONFIRMED` | withdraw: no confirmation came back; check the agent wallet balance before trying again |

## What goes over the network

Demo: only Degenly's public read endpoints on `https://degenly.app`: `/api/swap/quote` (price only, no wallet),
`/api/data/tokens`, `/api/data/search`, `/api/data/top`. Each quote is a real upstream call for Degenly, so the
package caps itself at 1 quote per 2 s and 300 per day per computer (`~/.degenly/quote-limit.json`).
Live: only signed requests to `https://degenly.app/v1/*`. The agent wallet key never leaves this computer; requests
carry the API key and a signature. No cookies, no telemetry.

## Run from source (until it is published)

```
npm install
npm run build
node dist/cli.js demo status --json
node dist/cli.js mcp
```

Claude Code against the local build: `claude mcp add degenly -- node <absolute path>/dist/cli.js`.

Tests: `npm test` (no network: `fetch` is faked). Requires Node 20+.
