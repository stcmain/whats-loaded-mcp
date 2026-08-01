# whats-loaded-mcp

[![npm](https://img.shields.io/npm/v/whats-loaded-mcp)](https://www.npmjs.com/package/whats-loaded-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![stcmain/whats-loaded-mcp MCP server](https://glama.ai/mcp/servers/stcmain/whats-loaded-mcp/badges/score.svg)](https://glama.ai/mcp/servers/stcmain/whats-loaded-mcp)

**Your context window is already half spent before you type.** An MCP server that shows what is consuming it — every skill description, every memory file and its hidden `@imports`, every configured MCP server — ranked by cost, with duplicates called out.

## Why

Skills are cheap to install and permanently expensive to keep. A skill's `name` and `description` go into the system prompt of **every session, forever** — only the body is loaded on demand. Install a few hundred and you've quietly mortgaged half your window before the first message.

Nothing surfaces this. You notice it as sessions that compact sooner than they used to, and you have no idea which of the things you installed six months ago is responsible.

On the machine this was written on:

```
# Context budget — cost before you type a single character

**~95,316 estimated tokens always loaded.**
For scale: ~47.7% of a 200K window, ~9.5% of a 1M window.

| Source                                       | Count |  Est. tokens |
|----------------------------------------------|------:|-------------:|
| Skill descriptions                           | 1,767 |       92,884 |
| Memory files (CLAUDE.md/AGENTS.md + imports) |     3 |        2,432 |
| MCP servers configured                       |    10 | not measured |
| **Total measurable**                         |       |   **95,316** |

> **79 duplicate skill names** are costing ~9,435 tokens.
```

79 names were installed more than once — the same skill picked up from several sources, like `agent-browser` appearing three times from three authors. But a shared name does not always mean a redundant copy: on that install only **34 groups were byte-identical** (~1,523 tokens genuinely recoverable), while **45 shared a name and differed in content** — different work wearing the same label, where deleting a copy loses something. `duplicate_skills` compares content hashes and reports those two groups separately, so the cleanup advice is safe to act on rather than merely impressive.

## Tools

| Tool | What it answers |
|---|---|
| `context_budget` | The headline: how much is loaded before you type, split by source. Start here |
| `skill_costs` | Skills ranked by token cost, so you trim where it actually pays |
| `duplicate_skills` | The same skill installed more than once — usually pure waste |
| `memory_files` | `CLAUDE.md`/`AGENTS.md` sizes **and** what their `@import` lines silently pull in |
| `mcp_servers` | Every MCP server configured across your clients, and which config declares it |

## Install

Register with Claude Code (available in every session):

```bash
claude mcp add --scope user whats-loaded -- npx -y whats-loaded-mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "whats-loaded": {
      "command": "npx",
      "args": ["-y", "whats-loaded-mcp"]
    }
  }
}
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/stcmain/whats-loaded-mcp.git
cd whats-loaded-mcp
npm install && npm run build
# then point your client at node /path/to/whats-loaded-mcp/dist/index.js
```

</details>

Published as [`whats-loaded-mcp`](https://www.npmjs.com/package/whats-loaded-mcp) on npm and as
`io.github.stcmain/whats-loaded-mcp` in the [MCP Registry](https://registry.modelcontextprotocol.io/).

No configuration. No environment variables.

## What it counts, and what it refuses to guess

Getting this wrong in the flattering direction would be easy, so the accounting is deliberately conservative:

- **Skill descriptions only.** `name` + `description` is what loads at startup. The body of a `SKILL.md` is fetched on demand and is **not** counted, even though it is 100× larger.
- **Enabled plugins only.** Skills belonging to disabled plugins sit on disk costing nothing, and are reported separately rather than folded into the total.
- **One version per plugin.** The plugin cache keeps several content-hash copies of the same plugin; only the live one is counted. Counting them all would inflate the total and invent duplicates you cannot act on.
- **`marketplaces/` is never counted.** That tree is a git checkout of marketplace *source*, not installed content.

## Honest limitations

- **Token counts are estimates** (~4 chars/token). Real counts depend on the tokenizer; prose runs lighter, code and CJK run denser. Treat the numbers as a ranking and a rough scale, not as billing. Anthropic's tokenizer is not public, so nothing local can do better than an estimate.
- **MCP tool definitions are not measured.** They can be a large share of your context, but measuring them means launching every server and enumerating its tools. This server does not launch anything, so it reports the server count and says so rather than guessing.
- **JSON configs only.** TOML-based clients (Codex `config.toml`) are not parsed.
- **Client-specific.** Built around the Claude Code layout (`~/.claude`). The MCP inventory reads Claude Desktop, Cursor, Windsurf and VS Code configs too, but skill accounting is Claude Code's model.
- **It reports; it does not edit.** Nothing is deleted, disabled or rewritten. Acting on the findings is your call.

## Design notes / threat model

This server's output goes straight into a model's context, so the interesting risk is not what it does to your machine — it is what it hands to the model.

- **No child processes. No network.** It only reads files. There is no `exec`, no shell, and no outbound connection anywhere in the codebase.
- **No model input ever becomes a path.** Every path is derived from `homedir()` or `cwd()`. The only model-controlled parameters are a clamped integer and a substring matched in memory against names already collected. Path traversal is not possible because there is no path construction to traverse.
- **Memory file contents are never read into the report.** `CLAUDE.md` routinely contains private operational detail. This server reports size and the import graph, never a line of content.
- **MCP environment values are never read.** Config files are where people leave API keys in plaintext. Only variable *names* are emitted — never values, not even masked.
- **Skill names and descriptions are emitted,** which is a deliberate exception: they are already in the model's context by definition, so reporting them discloses nothing new.
- Bounded work: depth-capped directory walks, symlink-loop protection via realpath, and a file size ceiling.

## Who makes this

Built by [Shift The Culture](https://shifttheculture.media/?utm_source=github&utm_medium=readme&utm_campaign=whats-loaded-mcp) — we run a one-person company on AI agents and ship the tooling we needed ourselves. This server is free and MIT-licensed, no strings.

Its sibling, [**whats-running-mcp**](https://github.com/stcmain/whats-running-mcp), does the same job for live process state: what is *actually* running on the box, instead of what an old transcript claims. Also free, also MIT.

The rest of that tooling is paid:

- **[Agent Fleet Ops Kit](https://stcai.gumroad.com/l/agent-fleet-ops-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-loaded-mcp)** ($29) — the other failure modes of running three or four agents on one box: two sessions editing the same checkout, a dev server nobody owns (so the agent tests a different app than it edits), and MCP servers leaked from crashed sessions that hold ports and RAM for weeks.
- **[Agent Reliability Kit](https://stcai.gumroad.com/l/agent-reliability-kit?wanted=true&utm_source=github&utm_medium=readme&utm_campaign=whats-loaded-mcp)** ($29) — a Stop hook and two CLIs that block a turn when an agent claims "done" against a repo, URL, or build that was never actually checked.

The server above stays free and MIT either way — it has no upsell in it, no telemetry, and no dependency on the paid kits.

## License

MIT © Zachary Pampu
