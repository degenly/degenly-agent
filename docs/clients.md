# Client setup

`@degenly/agent` is a local MCP stdio server. Every client below starts it with `npx -y @degenly/agent@0.2.0`.
Demo tools use demo SOL only; live tools use the agent wallet after the 3 setup steps in the README.

How the confirmation step works in this package: before a live buy / sell is sent, the server asks the human with
an MCP **form elicitation** (one checkbox, "Confirm this real trade", 120 s). Only a ticked, accepted form sends the
trade. If the client does not announce form elicitation, the trade is NOT sent and the answer is
`CONFIRM_UNSUPPORTED`; only the human can then set `DEGENLY_CONFIRM=off` in the server's configuration (spending
limits on degenly.app `/bot` still apply). "Not verified" below means we have not confirmed it from the client's own
documentation or tested it with this package.

## Claude Code

```
claude mcp add degenly -- npx -y @degenly/agent@0.2.0
```

Source: [Claude Code MCP](https://code.claude.com/docs/en/mcp).

- Confirmation form: the Claude Code MCP docs mention elicitation dialogs that block a tool call while open
  (interactive sessions). Not tested with this package. Non-interactive runs (`claude -p`): not verified; any
  answer other than a ticked, accepted form means nothing is sent.
- Extra safety layer: add `Read(~/.degenly/**)` to `permissions.deny` in `~/.claude/settings.json`. It does not
  cover Bash commands in general, e.g. `grep -r` run from the folder ("Read and Edit" warning in
  [Claude Code permissions](https://code.claude.com/docs/en/permissions)).

## Gemini CLI

```
gemini mcp add degenly npx -y @degenly/agent@0.2.0
```

Source: [gemini-cli mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
(stdio transport; tool calls go through the CLI's own confirmation logic based on server trust settings).

- Confirmation form (elicitation): not verified. If it is not supported, live buys / sells answer
  `CONFIRM_UNSUPPORTED` and nothing is sent.
- A file-read deny rule like Claude Code's: not verified.

## Cursor

Add to `mcp.json`:

```json
{ "mcpServers": { "degenly": { "command": "npx", "args": ["-y", "@degenly/agent@0.2.0"] } } }
```

Source: [Cursor MCP](https://cursor.com/docs/context/mcp) (stdio servers; the page lists elicitation support).

- Confirmation form: supported according to Cursor's docs. Not tested with this package.
- A file-read deny rule like Claude Code's: not verified.

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "degenly": { "command": "npx", "args": ["-y", "@degenly/agent@0.2.0"] } } }
```

Source: [MCP: connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
(Claude Desktop asks the user before each tool call).

- Confirmation form (elicitation): not verified. If it is not supported, live buys / sells answer
  `CONFIRM_UNSUPPORTED` and nothing is sent. Claude Desktop's own per-tool permission prompt is not the trade
  confirmation: it does not show the trade summary.

## Not supported / not verified

- ChatGPT: developer mode accepts only remote servers (SSE / streaming HTTP), not a local stdio server
  ([ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)). Not supported.
- Gemini web app: not verified.
