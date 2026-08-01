#!/usr/bin/env node
/**
 * whats-loaded-mcp — what is consuming your agent's context window before it starts.
 *
 * Every skill you install adds its name + description to the system prompt of
 * EVERY session, forever. Memory files (CLAUDE.md / AGENTS.md) and their
 * @imports load in full. None of this is visible anywhere: you find out when
 * long sessions start compacting early and you don't know why.
 *
 * This server reads the agent config surface on disk and reports the bill,
 * ranked, with duplicates called out.
 *
 * Security posture: this server spawns NO child processes and opens NO network
 * connections. It only reads files under a fixed set of agent-config roots.
 * No model-controlled input is ever used to build a filesystem path.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, dirname, resolve, isAbsolute } from "node:path";

const VERSION = "0.1.0";
const HOME = homedir();

/**
 * Characters per token. English prose on GPT/Claude-family tokenizers averages
 * ~4. This is an ESTIMATE and is documented as such everywhere it surfaces.
 * Code, JSON and CJK run denser (worse); plain prose runs lighter.
 */
const CHARS_PER_TOKEN = 4;

/** Rough structural overhead per skill entry in the system prompt (delimiters, newlines). */
const SKILL_ENTRY_OVERHEAD = 8;

const estTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/* ------------------------------------------------------------------ *
 * Filesystem helpers — read-only, bounded, and never path-injectable.
 * ------------------------------------------------------------------ */

function readTextSafe(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    // Guard against pathological files; a memory file this large is already a bug.
    if (st.size > 4 * 1024 * 1024) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function sizeSafe(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Bounded recursive walk for SKILL.md files. Depth-capped, symlink-loop safe. */
function findSkillFiles(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const visited = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === "SKILL.md") out.push(p);
      else if (e.isDirectory() || e.isSymbolicLink()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p, depth + 1);
      }
    }
  };

  walk(root, 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * Skill parsing
 * ------------------------------------------------------------------ */

interface Skill {
  name: string;
  descChars: number;
  cost: number; // always-loaded chars (name + description + overhead)
  path: string;
  source: string; // "personal" | "project" | "plugin:<id>"
  /**
   * sha256 of the raw SKILL.md. Two skills sharing a name are only safe to
   * dedupe when this matches — same-name copies frequently diverge in content,
   * and deleting one of those loses work rather than saving tokens.
   */
  contentHash: string;
}

/**
 * Extract the always-loaded part of a skill: its name and description.
 * The BODY of a SKILL.md is loaded on demand, not at startup — we deliberately
 * do not count it toward the always-loaded budget.
 */
function parseSkill(path: string, source: string): Skill | null {
  const text = readTextSafe(path);
  if (text === null) return null;

  const fmMatch = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = fmMatch ? fmMatch[1] : "";

  const nameMatch = /^name:\s*(.+)$/m.exec(fm);
  // description may be a folded/indented multi-line scalar
  const descMatch = /^description:\s*(.+(?:\r?\n[ \t]+.+)*)/m.exec(fm);

  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();

  const name = nameMatch ? unquote(nameMatch[1]) : basename(dirname(path));
  const desc = descMatch ? unquote(descMatch[1]).replace(/\s+/g, " ") : "";

  return {
    name,
    descChars: desc.length,
    cost: name.length + desc.length + SKILL_ENTRY_OVERHEAD,
    path,
    source,
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
}

/** Which plugins are actually enabled? Disabled plugin skills cost nothing. */
function enabledPlugins(): { enabled: Set<string>; known: number } {
  const settings = readTextSafe(join(HOME, ".claude", "settings.json"));
  const enabled = new Set<string>();
  let known = 0;
  if (!settings) return { enabled, known };
  try {
    const parsed = JSON.parse(settings) as { enabledPlugins?: Record<string, boolean> };
    const ep = parsed.enabledPlugins ?? {};
    for (const [k, v] of Object.entries(ep)) {
      known++;
      if (v === true) enabled.add(k);
    }
  } catch {
    /* malformed settings — treat as no plugin info */
  }
  return { enabled, known };
}

interface SkillScan {
  loaded: Skill[];
  onDiskNotLoaded: number;
  projectDir: string | null;
}

function scanSkills(): SkillScan {
  const loaded: Skill[] = [];
  const seenPaths = new Set<string>();

  const addFrom = (dir: string, source: string) => {
    for (const d of listDirs(dir)) {
      const p = join(dir, d, "SKILL.md");
      if (!existsSync(p)) continue;
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        real = p;
      }
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);
      const s = parseSkill(p, source);
      if (s) loaded.push(s);
    }
  };

  // 1. Personal skills — always loaded.
  addFrom(join(HOME, ".claude", "skills"), "personal");

  // 2. Project skills — loaded when working in this directory.
  const cwd = process.cwd();
  const projectSkillDir = join(cwd, ".claude", "skills");
  const hasProject = existsSync(projectSkillDir);
  if (hasProject) addFrom(projectSkillDir, "project");

  // 3. Plugin skills — ONLY enabled plugins, and only the active cached version.
  //
  // Layout: ~/.claude/plugins/cache/<marketplace>/<plugin>/<contentHash>/**/SKILL.md
  // The cache retains several <contentHash> versions of the same plugin; only one
  // is live, so counting them all would inflate the budget and invent duplicates.
  // We keep the most recently modified hash directory per plugin.
  //
  // ~/.claude/plugins/marketplaces/** is a git checkout of the marketplace SOURCE,
  // not installed content — it is never loaded and is never counted.
  const { enabled } = enabledPlugins();
  const pluginRoot = join(HOME, ".claude", "plugins");
  const cacheRoot = join(pluginRoot, "cache");
  let notLoaded = 0;

  const marketplacesRoot = join(pluginRoot, "marketplaces");
  if (existsSync(marketplacesRoot)) notLoaded += findSkillFiles(marketplacesRoot).length;

  for (const marketplace of listDirs(cacheRoot)) {
    for (const plugin of listDirs(join(cacheRoot, marketplace))) {
      const pluginDir = join(cacheRoot, marketplace, plugin);
      const versions = listDirs(pluginDir);
      if (versions.length === 0) continue;

      const isEnabled = enabled.has(`${plugin}@${marketplace}`);

      // Newest version by mtime is the live one.
      let active = versions[0];
      let activeMtime = -1;
      for (const v of versions) {
        try {
          const m = statSync(join(pluginDir, v)).mtimeMs;
          if (m > activeMtime) {
            activeMtime = m;
            active = v;
          }
        } catch {
          /* skip unreadable version dir */
        }
      }

      for (const v of versions) {
        const files = findSkillFiles(join(pluginDir, v));
        if (v !== active || !isEnabled) {
          notLoaded += files.length;
          continue;
        }
        for (const p of files) {
          let real: string;
          try {
            real = realpathSync(p);
          } catch {
            real = p;
          }
          if (seenPaths.has(real)) continue;
          seenPaths.add(real);
          const s = parseSkill(p, `plugin:${plugin}`);
          if (s) loaded.push(s);
        }
      }
    }
  }

  return { loaded, onDiskNotLoaded: notLoaded, projectDir: hasProject ? cwd : null };
}

/* ------------------------------------------------------------------ *
 * Memory files (CLAUDE.md / AGENTS.md) + @imports
 * ------------------------------------------------------------------ */

interface MemFile {
  path: string;
  chars: number;
  estTokens: number;
  importedBy?: string;
}

/**
 * Memory files load in FULL, and `@relative/path.md` lines pull in more files
 * that never show up in the parent's own size. We report sizes and the import
 * graph — never the contents, which are frequently private.
 */
function scanMemoryFiles(): MemFile[] {
  const out: MemFile[] = [];
  const seen = new Set<string>();

  const visit = (path: string, importedBy?: string, depth = 0) => {
    if (depth > 5) return;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    const size = sizeSafe(path);
    if (size === null) return;
    seen.add(real);

    out.push({ path, chars: size, estTokens: estTokens(size), importedBy });

    const text = readTextSafe(path);
    if (!text) return;
    // `@path` at start of a line = import directive
    for (const line of text.split(/\r?\n/)) {
      const m = /^@([^\s]+)\s*$/.exec(line.trim());
      if (!m) continue;
      const target = m[1];
      // Imports come from the user's own config files, not from model input.
      const resolved = isAbsolute(target)
        ? target
        : target.startsWith("~/")
          ? join(HOME, target.slice(2))
          : resolve(dirname(path), target);
      visit(resolved, path, depth + 1);
    }
  };

  const cwd = process.cwd();
  const candidates = [
    join(HOME, ".claude", "CLAUDE.md"),
    join(HOME, ".claude", "AGENTS.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".claude", "CLAUDE.md"),
  ];
  for (const c of candidates) visit(c);
  return out;
}

/* ------------------------------------------------------------------ *
 * MCP server inventory
 * ------------------------------------------------------------------ */

interface McpEntry {
  server: string;
  client: string;
  configPath: string;
  command: string | null;
  /** Names only. Values are NEVER read or emitted — they are frequently secrets. */
  envKeys: string[];
}

const MCP_CONFIGS: Array<{ client: string; path: string; key: string }> = [
  { client: "claude-code (global)", path: join(HOME, ".claude.json"), key: "mcpServers" },
  {
    client: "claude-desktop",
    path: join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    key: "mcpServers",
  },
  { client: "cursor", path: join(HOME, ".cursor", "mcp.json"), key: "mcpServers" },
  { client: "windsurf", path: join(HOME, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
  { client: "vscode", path: join(HOME, ".vscode", "mcp.json"), key: "servers" },
];

function scanMcpServers(): { entries: McpEntry[]; scanned: string[]; missing: string[] } {
  const entries: McpEntry[] = [];
  const scanned: string[] = [];
  const missing: string[] = [];

  const configs = [
    ...MCP_CONFIGS,
    { client: "project (.mcp.json)", path: join(process.cwd(), ".mcp.json"), key: "mcpServers" },
  ];

  for (const { client, path, key } of configs) {
    const text = readTextSafe(path);
    if (text === null) {
      missing.push(path);
      continue;
    }
    scanned.push(path);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const servers = (parsed[key] ?? {}) as Record<string, { command?: string; env?: Record<string, string> }>;
      for (const [server, cfg] of Object.entries(servers)) {
        if (typeof cfg !== "object" || cfg === null) continue;
        entries.push({
          server,
          client,
          configPath: path,
          command: typeof cfg.command === "string" ? cfg.command : null,
          envKeys: Object.keys(cfg.env ?? {}),
        });
      }
    } catch {
      /* malformed config — skip rather than fail the whole scan */
    }
  }
  return { entries, scanned, missing };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const ESTIMATE_NOTE =
  `Token figures are ESTIMATES (~${CHARS_PER_TOKEN} chars/token). Real counts vary by tokenizer ` +
  `and content — prose runs lighter, code/JSON/CJK run denser. Use these to rank and compare, ` +
  `not as exact billing.`;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

const server = new McpServer({ name: "whats-loaded", version: VERSION });

server.registerTool(
  "context_budget",
  {
    title: "Context budget",
    description:
      "The headline answer: how much of the context window is consumed before the conversation " +
      "starts, broken down by source (skills, memory files, MCP servers). Use this first.",
    inputSchema: {},
  },
  async () => {
    const { loaded, onDiskNotLoaded, projectDir } = scanSkills();
    const mem = scanMemoryFiles();
    const mcp = scanMcpServers();

    const skillChars = loaded.reduce((a, s) => a + s.cost, 0);
    const memChars = mem.reduce((a, m) => a + m.chars, 0);
    const totalChars = skillChars + memChars;
    const total = estTokens(totalChars);

    const names = new Map<string, number>();
    for (const s of loaded) names.set(s.name, (names.get(s.name) ?? 0) + 1);
    const dupNames = [...names.values()].filter((c) => c > 1).length;
    const dupWaste = loaded
      .filter((s) => (names.get(s.name) ?? 0) > 1)
      .reduce((a, s) => a + s.cost, 0);

    const lines: string[] = [];
    lines.push("# Context budget — cost before you type a single character\n");
    lines.push(`**~${fmt(total)} estimated tokens always loaded.**`);
    lines.push(
      `For scale: ~${((total / 200_000) * 100).toFixed(1)}% of a 200K window, ` +
        `~${((total / 1_000_000) * 100).toFixed(1)}% of a 1M window.\n`,
    );

    lines.push("| Source | Count | Est. tokens |");
    lines.push("|---|---:|---:|");
    lines.push(`| Skill descriptions | ${fmt(loaded.length)} | ${fmt(estTokens(skillChars))} |`);
    lines.push(`| Memory files (CLAUDE.md/AGENTS.md + imports) | ${mem.length} | ${fmt(estTokens(memChars))} |`);
    lines.push(`| MCP servers configured | ${mcp.entries.length} | not measurable — see note |`);
    lines.push(`| **Total measurable** | | **${fmt(total)}** |\n`);

    if (dupNames > 0) {
      lines.push(
        `> **${dupNames} duplicate skill names** are costing ~${fmt(estTokens(dupWaste))} tokens. ` +
          `Run \`duplicate_skills\` — it separates byte-identical copies (safe to remove) from ` +
          `same-name skills whose content differs (deleting those loses work).\n`,
      );
    }
    if (onDiskNotLoaded > 0) {
      lines.push(
        `> ${fmt(onDiskNotLoaded)} plugin skills are on disk but belong to disabled plugins, ` +
          `so they cost nothing. Not counted above.\n`,
      );
    }
    if (projectDir) lines.push(`> Project skills included from \`${projectDir}\`.\n`);

    lines.push("**MCP servers:** their tool definitions also consume context, often heavily, but");
    lines.push("measuring them requires launching each server and enumerating its tools. This server");
    lines.push("deliberately does not launch anything, so it reports the count only — not a token cost.\n");
    lines.push(`_${ESTIMATE_NOTE}_`);

    return text(lines.join("\n"));
  },
);

server.registerTool(
  "skill_costs",
  {
    title: "Skill costs (ranked)",
    description:
      "Skills ranked by how many tokens their always-loaded description costs. The top of this " +
      "list is where trimming pays off most.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(25).describe("How many skills to return"),
      filter: z.string().optional().describe("Only include skills whose name contains this substring"),
    },
  },
  async ({ limit, filter }) => {
    const { loaded } = scanSkills();
    const needle = filter?.toLowerCase();
    const rows = loaded
      .filter((s) => (needle ? s.name.toLowerCase().includes(needle) : true))
      .sort((a, b) => b.cost - a.cost);

    if (rows.length === 0) return text("No skills matched.");

    const shown = rows.slice(0, limit);
    const totalAll = loaded.reduce((a, s) => a + s.cost, 0);

    const lines: string[] = [];
    lines.push(
      `# Skill cost ranking — ${fmt(shown.length)} of ${fmt(rows.length)} matching ` +
        `(${fmt(loaded.length)} loaded total, ~${fmt(estTokens(totalAll))} tokens)\n`,
    );
    lines.push("| Est. tokens | Skill | Source |");
    lines.push("|---:|---|---|");
    for (const s of shown) {
      lines.push(`| ${fmt(estTokens(s.cost))} | ${s.name} | ${s.source} |`);
    }
    lines.push(`\n_${ESTIMATE_NOTE}_`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "duplicate_skills",
  {
    title: "Duplicate skills",
    description:
      "Skills whose name appears more than once (same skill installed from several sources). " +
      "Every copy pays full description cost in every session. Copies are compared by content hash: " +
      "identical copies are safe to remove, same-name copies that DIFFER are flagged for review because " +
      "deleting one would lose work.",
    inputSchema: {},
  },
  async () => {
    const { loaded } = scanSkills();
    const byName = new Map<string, Skill[]>();
    for (const s of loaded) {
      const arr = byName.get(s.name) ?? [];
      arr.push(s);
      byName.set(s.name, arr);
    }
    const dups = [...byName.entries()]
      .filter(([, v]) => v.length > 1)
      .sort((a, b) => b[1].length * b[1][0].cost - a[1].length * a[1][0].cost);

    if (dups.length === 0) return text("No duplicate skill names found.");

    // A shared name does NOT mean a redundant copy. Compare content hashes:
    // identical copies are genuinely free to remove; same-name copies whose
    // content differs are distinct work wearing the same label, and deleting
    // one loses it. Only the identical ones are counted as recoverable.
    const identical: [string, Skill[]][] = [];
    const divergent: [string, Skill[]][] = [];
    for (const entry of dups) {
      const hashes = new Set(entry[1].map((c) => c.contentHash));
      (hashes.size === 1 ? identical : divergent).push(entry);
    }

    // Recoverable = every copy beyond the first, identical groups ONLY.
    const waste = identical.reduce((a, [, v]) => a + v.slice(1).reduce((x, s) => x + s.cost, 0), 0);

    const lines: string[] = [];
    lines.push(`# Duplicate skill names — ${dups.length} names installed more than once\n`);
    lines.push(
      `**${identical.length} are byte-identical** and safe to dedupe, freeing roughly ` +
        `**${fmt(estTokens(waste))} tokens** per session. ` +
        `**${divergent.length} share a name but differ in content** — those are different skills wearing the ` +
        `same label, and deleting one loses work. Review those by hand; they are not counted above.\n`,
    );

    if (identical.length) {
      lines.push(`## Safe to dedupe — identical copies (${identical.length})\n`);
      lines.push("| Skill | Copies | Locations |");
      lines.push("|---|---:|---|");
      for (const [name, copies] of identical.slice(0, 40)) {
        const locs = copies.map((c) => c.path.replace(HOME, "~")).join("<br>");
        lines.push(`| ${name} | ${copies.length} | ${locs} |`);
      }
      if (identical.length > 40) lines.push(`\n…and ${identical.length - 40} more identical groups.`);
    }

    if (divergent.length) {
      lines.push(`\n## Same name, different content — review before deleting (${divergent.length})\n`);
      lines.push("| Skill | Copies | Locations |");
      lines.push("|---|---:|---|");
      for (const [name, copies] of divergent.slice(0, 40)) {
        const locs = copies.map((c) => c.path.replace(HOME, "~")).join("<br>");
        lines.push(`| ${name} | ${copies.length} | ${locs} |`);
      }
      if (divergent.length > 40) lines.push(`\n…and ${divergent.length - 40} more divergent groups.`);
    }
    lines.push(`\n_${ESTIMATE_NOTE}_`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "memory_files",
  {
    title: "Memory files and imports",
    description:
      "CLAUDE.md / AGENTS.md files that load in full every session, including files pulled in by " +
      "`@import` lines — the cost that hides behind a small-looking parent file. Reports sizes " +
      "and the import graph only, never file contents.",
    inputSchema: {},
  },
  async () => {
    const mem = scanMemoryFiles();
    if (mem.length === 0) return text("No CLAUDE.md / AGENTS.md files found in home or current directory.");

    const total = mem.reduce((a, m) => a + m.chars, 0);
    const lines: string[] = [];
    lines.push(`# Memory files — ${mem.length} file(s), ~${fmt(estTokens(total))} tokens loaded in full\n`);
    lines.push("| Est. tokens | Bytes | File | Pulled in by |");
    lines.push("|---:|---:|---|---|");
    for (const m of mem.sort((a, b) => b.chars - a.chars)) {
      lines.push(
        `| ${fmt(m.estTokens)} | ${fmt(m.chars)} | ${m.path.replace(HOME, "~")} | ` +
          `${m.importedBy ? m.importedBy.replace(HOME, "~") : "—"} |`,
      );
    }
    const imported = mem.filter((m) => m.importedBy);
    if (imported.length > 0) {
      lines.push(
        `\n> ${imported.length} of these are \`@import\`ed from another file — their cost does not ` +
          `show up in the importing file's own size.`,
      );
    }
    lines.push("\n> Contents are never read into this report — only sizes and the import graph.");
    lines.push(`\n_${ESTIMATE_NOTE}_`);
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "mcp_servers",
  {
    title: "MCP server inventory",
    description:
      "Every MCP server configured across the agent clients on this machine, and which config " +
      "declares it — useful for spotting servers you forgot you installed. Environment variable " +
      "NAMES only; values are never read.",
    inputSchema: {},
  },
  async () => {
    const { entries, scanned, missing } = scanMcpServers();

    const lines: string[] = [];
    lines.push(`# MCP servers configured on this machine — ${entries.length} entr(ies)\n`);

    if (entries.length === 0) {
      lines.push("No MCP servers found in any known client config.\n");
    } else {
      lines.push("| Server | Client | Launch | Env var names |");
      lines.push("|---|---|---|---|");
      for (const e of entries.sort((a, b) => a.server.localeCompare(b.server))) {
        lines.push(
          `| ${e.server} | ${e.client} | ${e.command ?? "—"} | ${e.envKeys.length ? e.envKeys.join(", ") : "—"} |`,
        );
      }

      const byServer = new Map<string, Set<string>>();
      for (const e of entries) {
        const s = byServer.get(e.server) ?? new Set<string>();
        s.add(e.client);
        byServer.set(e.server, s);
      }
      const multi = [...byServer.entries()].filter(([, c]) => c.size > 1);
      if (multi.length > 0) {
        lines.push(`\n> ${multi.length} server(s) are declared in more than one client config:`);
        for (const [s, c] of multi) lines.push(`> - \`${s}\` — ${[...c].join(", ")}`);
        lines.push("> Each copy must be kept in sync by hand; they drift silently.");
      }
    }

    lines.push(`\n**Configs read:** ${scanned.length ? scanned.map((p) => p.replace(HOME, "~")).join(", ") : "none"}`);
    lines.push(`\n**Not present:** ${missing.length} known config path(s) did not exist.`);
    lines.push(
      "\n> Limitations: JSON configs only — TOML-based clients (e.g. Codex `config.toml`) are not " +
        "parsed. Servers are never launched, so tool definitions and their token cost are not measured. " +
        "Environment variable **values are never read**, only names.",
    );
    return text(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
