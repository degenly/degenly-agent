# @degenly/agent

Degenly for AI agents: one package with an MCP server, a CLI and a `SKILL.md`.

**Demo mode (this version):** 10 demo SOL, live Degenly prices, no wallet, no key, no account, no browser step.
The demo record lives only on your computer in `~/.degenly/demo.json`; nothing about it is sent to Degenly.
Live trading is not available yet.

## Install (one line per client)

- Claude Code: `claude mcp add degenly -- npx -y @degenly/agent`
- Gemini CLI: `gemini mcp add degenly npx -y @degenly/agent`
- Cursor (`mcp.json`) / Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "degenly": { "command": "npx", "args": ["-y", "@degenly/agent"] } } }
```

Without arguments (or with `mcp`) the package starts the MCP stdio server. With a command it is the CLI:
`npx -y @degenly/agent demo status --json`. Agent instructions: [SKILL.md](SKILL.md).

## Tools / commands

| MCP tool | CLI | |
|---|---|---|
| `degenly_status` | `demo status` | demo balance, positions, realized P&L |
| `degenly_quote` | `demo quote <mint> buy <sol>` / `sell <amount\|N%\|all>` | live price only |
| `degenly_buy` | `demo buy <mint> <sol>` | demo buy at the live price |
| `degenly_sell` | `demo sell <mint> <N%\|all>` | demo sell at the live price |
| `degenly_trades` | `demo trades [--limit N]` | demo history, newest first |
| `degenly_reset` | `demo reset` | back to 10 demo SOL |
| `degenly_token` | `token <mint>` | name / symbol (untrusted), decimals, price, authorities |
| `degenly_search` | `search <text>` | find mints by name or symbol |
| `degenly_trending` | `trending [5m\|1h\|6h\|24h] [--limit N]` | most traded on Degenly |

Every answer carries `"mode":"demo"` and `"note":"Demo trade. No real funds moved."`. Errors: non-zero exit and
`{"ok":false,"error":"CODE","hint":"..."}` (codes in SKILL.md).

## What goes over the network

Only Degenly's public read endpoints on `https://degenly.app`: `/api/swap/quote` (price only, no wallet),
`/api/data/tokens`, `/api/data/search`, `/api/data/top`. No cookies, no keys, no telemetry.
Each quote is a real upstream call for Degenly, so the package caps itself at 1 quote per 2 s and 300 per day per
computer (`~/.degenly/quote-limit.json`).

## Run from source (until it is published)

```
npm install
npm run build
node dist/cli.js demo status --json
node dist/cli.js mcp
```

Claude Code against the local build: `claude mcp add degenly -- node <absolute path>/dist/cli.js`.

Tests: `npm test` (no network: `fetch` is faked). Requires Node 20+.
