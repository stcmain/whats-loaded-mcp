import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpHarness } from "./helpers/mcp-client.mjs";

/**
 * Drives the built server over stdio exactly as an MCP host does.
 * Deliberately does not hardcode tool names: it discovers them via tools/list
 * and exercises whatever the server actually advertises, so adding a tool
 * extends the coverage instead of silently escaping it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let mcp;
let tools = [];

before(async () => {
  mcp = new McpHarness(join(ROOT, "dist/index.js"));
  await mcp.start();
  tools = (await mcp.listTools()).tools;
});

after(async () => {
  await mcp?.stop();
});

describe("handshake", () => {
  test("negotiates a protocol version", () => {
    assert.ok(mcp.initializeResult.protocolVersion);
  });

  test("reports the version from package.json, not a hardcoded string", () => {
    assert.equal(mcp.initializeResult.serverInfo.version, PKG.version, "reported version drifted from package.json");
  });

  test("writes nothing to stdout that is not JSON-RPC", () => {
    // stdout is the transport; stray logging corrupts the stream for the host.
    assert.equal(mcp.buffer.trim(), "", `unparsed stdout remainder: ${mcp.buffer.slice(0, 200)}`);
  });
});

describe("tools/list", () => {
  test("advertises at least one tool", () => {
    assert.ok(tools.length > 0, "server advertises no tools");
  });

  test("every tool is meaningfully documented", () => {
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 20, `${t.name} has no meaningful description`);
    }
  });

  test("tool names are stable identifiers", () => {
    for (const t of tools) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} is not a snake_case identifier`);
    }
  });
});

describe("tools/call", () => {
  test("every advertised tool responds without crashing the server", async () => {
    for (const t of tools) {
      const res = await mcp.callTool(t.name);
      assert.ok(Array.isArray(res.content) && res.content.length > 0, `${t.name} returned no content`);
      assert.equal(res.content[0].type, "text", `${t.name} returned non-text content`);
    }
  });

  test("hostile input is handled in-process and never reaches a shell", async () => {
    // These servers must not execute processes at all (asserted statically in
    // contract.test.mjs). This is the runtime half of that claim.
    const canary = "/tmp/whats-mcp-pwned-canary";
    const hostile = `"; touch ${canary}; #`;
    for (const t of tools) {
      const props = t.inputSchema?.properties ?? {};
      const args = {};
      for (const [k, v] of Object.entries(props)) {
        if (v.type === "string") args[k] = hostile;
      }
      if (Object.keys(args).length === 0) continue;
      const res = await mcp.callTool(t.name, args);
      assert.ok(res, `${t.name} returned nothing for hostile input`);
    }
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(canary), false, "COMMAND INJECTION: hostile input reached a shell");
  });

  test("an unknown tool is reported as an error, not silently ignored", async () => {
    const res = await mcp.callTool("definitely_not_a_tool");
    assert.equal(res.isError, true, "unknown tool did not set isError");
  });

  test("the server survives a call with unexpected extra arguments", async () => {
    const res = await mcp.callTool(tools[0].name, { __unexpected_arg__: "x" });
    assert.ok(res, "server did not respond to a call with an unknown argument");
  });
});
