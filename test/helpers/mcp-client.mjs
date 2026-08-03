import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Minimal JSON-RPC-over-stdio client for driving the built server the same way
 * a real MCP host does. Deliberately dependency-free: this package ships two
 * runtime deps and the tests should not quietly add more.
 */
export class McpHarness {
  constructor(entry = "dist/index.js") {
    this.entry = entry;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.buffer = "";
  }

  async start() {
    this.proc = spawn(process.execPath, [this.entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => {
      this.stderr += d;
    });
    this.proc.stdout.on("data", (chunk) => this.#onData(chunk));

    this.initializeResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "whats-running-tests", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return this.initializeResult;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON-RPC framing; ignore rather than fail the run
      }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method} (stderr: ${this.stderr.slice(0, 300)})`)),
        20_000,
      );
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  listTools() {
    return this.request("tools/list");
  }

  callTool(name, args = {}) {
    return this.request("tools/call", { name, arguments: args });
  }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.stdin.end();
    this.proc.kill();
    await once(this.proc, "exit").catch(() => {});
  }
}
