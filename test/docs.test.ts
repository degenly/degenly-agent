/**
 * DGAJ17: the docs and the code must not drift apart.
 *  - Every command line in README.md / SKILL.md / docs/clients.md (inline code spans + fenced code lines that start
 *    with `degenly`, `npx -y @degenly/agent` or `node dist/cli.js`) is read FROM THE FILE, its placeholders are filled
 *    in, and the real CLI parser (`runCli`) must recognize it: not UNKNOWN_COMMAND, not BAD_ARGS, not the demo-only
 *    NOT_AVAILABLE_IN_DEMO. A renamed / removed command turns this red.
 *  - Client install lines = DGAJ-S A2 table byte for byte; the JSON block parses to the same command.
 *  - The safety sentence = the package constant (AGENT_WALLET_WARNING); the Claude Code deny rule + its limit note.
 * Temp home, fake fetch: no network.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/api.js";
import { createOps, runCli, type LiveDeps } from "../src/cli.js";
import { LIVE_NOT_AVAILABLE } from "../src/client.js";
import { AGENT_WALLET_WARNING } from "../src/keys.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (f: string): string => readFileSync(join(ROOT, f), "utf8");
const README = read("README.md");
const SKILL = read("SKILL.md");
const CLIENTS = read("docs/clients.md");
const PKG = JSON.parse(read("package.json")) as { name: string; version: string; private: boolean; bin: Record<string, string>; scripts: Record<string, string>; files: string[] };

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const OWNER = "7rhxnLV8C77o6d8oz26AgK8x8m5ePsdeRawjqvojbjnQ";
const NOW = 1791594000000;
const REFUSED = ["UNKNOWN_COMMAND", "BAD_ARGS", "NOT_AVAILABLE_IN_DEMO"];

/** DGAJ22 (E-2): every documented npx command pins the package version (= package.json `version`). */
const VERSION = "0.1.1";
const PINNED = `@degenly/agent@${VERSION}`;

/** DGAJ-S A2 "Kurulum metni" step 3, with the DGAJ22 pinned version. */
const A2_CLAUDE_CODE = `claude mcp add degenly -- npx -y ${PINNED}`;
const A2_GEMINI_CLI = `gemini mcp add degenly npx -y ${PINNED}`;
const A2_JSON = { command: "npx", args: ["-y", PINNED] };

// ---- extracting commands from a markdown file ---------------------------------------------------

/** Inline code spans + lines of fenced blocks (a `$ ` prompt and a trailing `# comment` are dropped). */
function codeTexts(md: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      // a line may hold several commands separated by " | " (SKILL.md)
      for (const part of line.replace(/^\$ /, "").replace(/\s+#.*$/, "").split(/\s+\|\s+/)) out.push(part.trim());
      continue;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push((m[1] ?? "").replace(/\\\|/g, "|").trim());
  }
  return out;
}

const PREFIXES = [`npx -y ${PINNED}`, "node dist/cli.js", "degenly"];

/** Command lines of the package (argv after the program), as written in the doc (placeholders kept). */
function commandLines(md: string): string[] {
  const out: string[] = [];
  for (const t of codeTexts(md)) {
    const p = PREFIXES.find((x) => t === x || t.startsWith(`${x} `));
    if (p === undefined) continue;
    out.push(t.slice(p.length).trim());
  }
  return [...new Set(out)];
}

/** Every concrete argv a documented line stands for: `<...>` filled, `a|b` alternatives and `[opt]` expanded. */
function expand(line: string): string[] {
  const m = /<([^>]+)>|\[([^\]]+)\]/.exec(line);
  if (!m) return [line.replace(/\s+/g, " ").trim()];
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length);
  let values: string[];
  if (m[1] !== undefined) {
    values = m[1].split("|").map((v) => {
      const s = v.trim();
      if (s === "mint") return MINT;
      if (s === "sol") return "0.05";
      if (s === "amount") return "1000";
      if (s === "N%") return "50%";
      if (s === "text") return "bonk";
      if (s === "main wallet address") return OWNER;
      if (s === "path") return join(tmpdir(), "dgaj17-no-such-key-file.txt");
      return s; // "all" and other literals
    });
  } else {
    values = ["", ...(m[2] ?? "").split("|").map((v) => v.trim().replace(/\bN\b/, "5"))];
  }
  return values.flatMap((v) => expand(`${before}${v}${after}`));
}

function rig() {
  const home = mkdtempSync(join(tmpdir(), "dgaj17-docs-"));
  // the Bot API is off (404), demo endpoints fail: a recognized command still answers with its own code
  const fetch: FetchLike = async () => new Response(JSON.stringify({ ok: false, error: "NOT_FOUND" }), { status: 404 });
  const live: LiveDeps = { home, env: {}, fetch, now: () => NOW, readStdin: async () => "" };
  const ops = createOps({ home, fetch, now: () => NOW });
  return { run: (argv: string[]) => runCli(argv, ops, live) };
}

/** `degenly` with no argument / `mcp` is the MCP server (cli.ts `main`), not a `runCli` command. */
const isServerStart = (argv: string[]) => argv.length === 0 || (argv.length === 1 && argv[0] === "mcp");

async function checkRecognized(doc: string, lines: string[]): Promise<string[]> {
  const ran: string[] = [];
  for (const line of lines) {
    for (const concrete of expand(line)) {
      const argv = concrete === "" ? [] : concrete.split(" ");
      if (isServerStart(argv)) {
        ran.push(`(server) ${concrete}`);
        continue;
      }
      const r = await rig().run([...argv, "--json"]);
      const a = JSON.parse(r.out) as { ok: boolean; error?: string; mode?: string };
      expect(REFUSED, `${doc}: \`${line}\` → ${concrete} answered ${a.error}`).not.toContain(a.error);
      expect(["demo", "live"]).toContain(a.mode);
      ran.push(concrete);
    }
  }
  return ran;
}

// ---- tests ---------------------------------------------------------------------------------------

describe("DGAJ17 docs: every documented command is a real command", () => {
  it("README.md: all command lines parse (setup, pair, login, whoami, live ..., demo ..., token, search, trending, mcp)", async () => {
    const lines = commandLines(README);
    // the extraction itself must keep finding the documented commands (an empty list would pass silently)
    for (const must of ["setup --owner <main wallet address>", "login --key-file <path>", "whoami", "pair --owner <main wallet address>", "demo status --json", "live holdings", "live quote <mint> buy <sol>", "demo buy <mint> <sol>", "trending [5m|1h|6h|24h] [--limit N]", "mcp"]) {
      expect(lines, must).toContain(must);
    }
    const ran = await checkRecognized("README.md", lines);
    if (process.env.DGAJ17_LIST === "1") console.log(`README commands checked (${ran.length}):\n${ran.join("\n")}`);
    expect(ran.length).toBeGreaterThanOrEqual(30);
  });

  it("SKILL.md: all command lines parse; the file stays within 110 lines", async () => {
    expect(SKILL.split("\n").length).toBeLessThanOrEqual(110);
    const lines = commandLines(SKILL);
    for (const must of ["search bonk --json", "demo buy <mint> 0.1 --json", "setup --owner <main wallet address>", "login --key-file <path>", "live holdings", "help"]) {
      expect(lines, must).toContain(must);
    }
    await checkRecognized("SKILL.md", lines);
  });

  it("a command that does not exist is caught by the same check (the check can fail)", async () => {
    const r = await rig().run(["live", "buy", MINT, "0.05", "--json"]);
    expect(REFUSED).toContain((JSON.parse(r.out) as { error?: string }).error);
    const u = await rig().run(["deposit", "--json"]);
    expect((JSON.parse(u.out) as { error?: string }).error).toBe("UNKNOWN_COMMAND");
  });
});

describe("DGAJ17 docs: client install lines = DGAJ-S A2", () => {
  it("README + docs/clients.md carry the A2 lines byte for byte; the JSON block is the A2 command", () => {
    for (const [name, md] of [["README.md", README], ["docs/clients.md", CLIENTS]] as const) {
      const codes = codeTexts(md);
      expect(codes, name).toContain(A2_CLAUDE_CODE);
      expect(codes, name).toContain(A2_GEMINI_CLI);
      const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] ?? "") as { mcpServers?: { degenly?: unknown }; permissions?: unknown });
      const servers = blocks.filter((b) => b.mcpServers !== undefined);
      expect(servers.length, name).toBeGreaterThanOrEqual(1);
      for (const b of servers) expect(b.mcpServers?.degenly).toEqual(A2_JSON);
    }
  });

  it("`npx -y @degenly/agent@<version>` resolves to this package's CLI with no argument (= the MCP server)", () => {
    expect(PKG.name).toBe("@degenly/agent");
    // npx picks the bin named like the unscoped package name
    expect(PKG.bin.agent).toBe("dist/cli.js");
    expect(PKG.bin.degenly).toBe("dist/cli.js");
    expect(A2_JSON.args.at(-1)).toBe(`${PKG.name}@${PKG.version}`);
    expect(PKG.private).toBeUndefined();
    expect(Object.keys(PKG.scripts).filter((s) => /^(pre|post)install$|^prepare$/.test(s))).toEqual([]);
  });

  it("DGAJ22 E-2: every npx / args mention of the package in README, SKILL.md, docs/clients.md is pinned to package.json version", () => {
    expect(PKG.version).toBe(VERSION);
    let pinned = 0;
    for (const [name, md] of [["README.md", README], ["SKILL.md", SKILL], ["docs/clients.md", CLIENTS]] as const) {
      // `npx -y @degenly/agent` or a JSON args entry "@degenly/agent..." must carry @<version>
      for (const m of md.matchAll(/npx -y (@degenly\/agent\S*)|"(@degenly\/agent[^"]*)"/g)) {
        const spec = (m[1] ?? m[2] ?? "").replace(/[`,;).]+$/, "");
        expect(spec, `${name}: ${m[0]}`).toBe(PINNED);
        pinned++;
      }
    }
    expect(pinned).toBeGreaterThanOrEqual(12);
  });

  it("DGAJ22 E-2: npm-shrinkwrap.json ships with the package and locks the same tree", () => {
    expect(PKG.files).toContain("npm-shrinkwrap.json");
    const sw = JSON.parse(read("npm-shrinkwrap.json")) as { name: string; version: string; lockfileVersion: number; packages: Record<string, { version?: string; dev?: boolean }> };
    expect(sw.name).toBe(PKG.name);
    expect(sw.version).toBe(PKG.version);
    expect(sw.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(sw.packages["node_modules/@modelcontextprotocol/sdk"]?.version).toBe("1.32.2");
  });

  it("no command is invented for clients the design could not verify (ChatGPT, Gemini web app)", () => {
    for (const md of [README, CLIENTS]) {
      const codes = codeTexts(md).filter((c) => /chatgpt|openai|gemini\.google|bard/i.test(c));
      expect(codes).toEqual([]);
    }
    expect(CLIENTS).toMatch(/Gemini web app: not verified/);
    expect(README).toMatch(/Gemini web app: not verified/);
  });
});

describe("DGAJ17 docs: safety text", () => {
  it("README Safety: the warning sentence = AGENT_WALLET_WARNING (the same constant setup prints)", () => {
    const safety = README.slice(README.indexOf("## Safety"), README.indexOf("## Tools"));
    expect(safety).toContain(AGENT_WALLET_WARNING);
    expect(safety).toContain("Read(~/.degenly/**)");
    expect(safety).toContain("permissions");
    expect(safety).toContain("https://code.claude.com/docs/en/permissions");
    expect(safety).toMatch(/does not cover Bash commands/);
    expect(safety).toMatch(/\/bot` → "Spending limits"/);
    const deny = JSON.parse(/```json\n([\s\S]*?)```/.exec(safety)?.[1] ?? "{}") as { permissions?: { deny?: string[] } };
    expect(deny.permissions?.deny).toEqual(["Read(~/.degenly/**)"]);
  });

  it("DGAJ24: live trading is open; no doc says it is unavailable or tells the human not to fund; no date", () => {
    for (const [name, md] of [["README.md", README], ["SKILL.md", SKILL], ["docs/clients.md", CLIENTS]] as const) {
      expect(md, name).not.toContain(LIVE_NOT_AVAILABLE);
      expect(md, name).not.toMatch(/not available yet|do not fund|switched off|until live trading/i);
    }
    // the A4 warning sits at the top of the README, before the demo section
    const top = README.slice(0, README.indexOf("## Demo mode"));
    expect(top).toContain(AGENT_WALLET_WARNING);
    expect(README).toContain("## Demo mode\n");
    expect(README).toContain("Fund the agent wallet with SOL only with what you can afford to lose.");
    for (const md of [README, SKILL, CLIENTS]) {
      expect(md).not.toMatch(/\b(20\d\d-\d\d-\d\d|Q[1-4] 20\d\d|(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d|coming (soon|in))\b/i);
    }
  });

  it("README lists every MCP tool (demo + degenly_live_*)", async () => {
    const { TOOL_NAMES, LIVE_TOOL_NAMES } = await import("../src/mcp.js");
    for (const n of [...TOOL_NAMES, ...LIVE_TOOL_NAMES]) expect(README, n).toContain(`\`${n}\``);
  });

  it("package texts: no exchange / custody / payment wording, no return promises", () => {
    for (const [name, md] of [["README.md", README], ["SKILL.md", SKILL], ["docs/clients.md", CLIENTS]] as const) {
      expect(md, name).not.toMatch(/\bexchange\b|\bcustody\b|\bpayments?\b/i);
      expect(md, name).not.toMatch(/guaranteed|profit(s|able)?\b|to the moon|\b\d+x returns?\b/i);
    }
  });
});
