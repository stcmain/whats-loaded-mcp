import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Claims this package makes publicly — in the README, on npm, and in the
 * marketplace listings. Asserted here so a regression breaks CI instead of
 * quietly making the marketing false.
 *
 * If you change the server and something here fails, the right fix is usually
 * to change the claim, not to weaken the test.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");
const SOURCES = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, code: stripComments(readFileSync(join(SRC_DIR, f), "utf8")) }));

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe('claim: "no network — nothing leaves your machine, no telemetry"', () => {
  const MODULES = ["http", "https", "net", "tls", "dgram", "dns"];

  test("imports no networking module", () => {
    for (const { file, code } of SOURCES) {
      for (const mod of MODULES) {
        assert.ok(!new RegExp(`from\\s+["'](node:)?${mod}["']`).test(code), `${file} imports ${mod}`);
        assert.ok(!new RegExp(`require\\(\\s*["'](node:)?${mod}["']\\s*\\)`).test(code), `${file} requires ${mod}`);
      }
    }
  });

  test("makes no outbound calls", () => {
    for (const { file, code } of SOURCES) {
      for (const p of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\baxios\b/, /node-fetch/, /\bundici\b/]) {
        assert.ok(!p.test(code), `${file} matches ${p}`);
      }
    }
  });

  test("declares only the two expected runtime dependencies", () => {
    assert.deepEqual(
      Object.keys(PKG.dependencies ?? {}).sort(),
      ["@modelcontextprotocol/sdk", "zod"],
      "runtime dependency set changed — re-audit the no-network claim",
    );
  });
});

describe("claim: read-only — this server inspects, it never executes or writes", () => {
  test("never touches child_process at all", () => {
    // Stronger than the sibling whats-running-mcp, which needs execFile for
    // ps/lsof. This package only reads files, so ANY process execution is a
    // regression, not a design choice.
    for (const { file, code } of SOURCES) {
      // NOTE: the lookbehind excludes RegExp.prototype.exec() — `/re/.exec(s)`
      // is string matching, not process execution.
      for (const p of [/child_process/, /\bexecFile\b/, /\bexecSync\b/, /\bspawn\w*\s*\(/, /(?<![.\w])exec\s*\(/]) {
        assert.ok(!p.test(code), `${file} matches ${p} — this server must not execute processes`);
      }
    }
  });

  test("never writes to the filesystem", () => {
    for (const { file, code } of SOURCES) {
      for (const p of [/\bwriteFile\w*\s*\(/, /\bappendFile\w*\s*\(/, /\bunlink\w*\s*\(/, /\brm(dir)?\w*\s*\(/, /\bmkdir\w*\s*\(/, /createWriteStream/]) {
        assert.ok(!p.test(code), `${file} matches ${p} — this server must be read-only`);
      }
    }
  });

  test("filesystem reads are the only IO primitive used", () => {
    const all = SOURCES.map((s) => s.code).join("\n");
    assert.ok(/readFile|readdir/.test(all), "expected filesystem reads — did the IO surface change?");
  });
});

describe("claim: model-controlled input is bounded", () => {
  test("every string input declared to zod carries a length bound", () => {
    for (const { file, code } of SOURCES) {
      const stringInputs = [...code.matchAll(/(\w+)\s*:\s*z[\s\S]{0,30}?\.string\(\)([\s\S]{0,80}?)(?=,\n|\n\s*\})/g)];
      for (const m of stringInputs) {
        assert.match(m[2], /\.max\(\s*\d+\s*\)/, `${file}: input "${m[1]}" is an unbounded string`);
      }
    }
  });

  test("every numeric input declared to zod carries a ceiling", () => {
    for (const { file, code } of SOURCES) {
      const numInputs = [...code.matchAll(/(\w+)\s*:\s*z[\s\S]{0,30}?\.number\(\)([\s\S]{0,80}?)(?=,\n|\n\s*\})/g)];
      for (const m of numInputs) {
        assert.match(m[2], /\.max\(\s*\d+\s*\)|\.int\(\)/, `${file}: input "${m[1]}" is an unbounded number`);
      }
    }
  });
});

describe("claim: MIT licensed and honestly versioned", () => {
  test("license is MIT and LICENSE ships", () => {
    assert.equal(PKG.license, "MIT");
    assert.match(readFileSync(join(ROOT, "LICENSE"), "utf8"), /MIT License/i);
    assert.ok(PKG.files.includes("LICENSE"), "LICENSE must ship in the tarball");
  });

  test("version is read from package.json so it cannot drift from what is published", () => {
    const all = SOURCES.map((s) => s.code).join("\n");
    assert.match(all, /package\.json["']\)\.version|version.*createRequire/, "version must be read from package.json");
    assert.ok(!/version\s*:\s*["']\d+\.\d+\.\d+["']/.test(all), "hardcoded version string in source");
  });

  test("the tarball ships only build output and docs", () => {
    for (const f of PKG.files) {
      assert.ok(["dist", "README.md", "LICENSE"].includes(f), `unexpected entry in files: ${f}`);
    }
  });
});

describe("the suite runs everything it contains", () => {
  test("every test file is listed in the npm test script", () => {
    // node --test only gained glob support in Node 22 and these packages
    // support Node >=18, so files are passed explicitly.
    const files = readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs"));
    assert.ok(files.length > 0);
    for (const f of files) {
      assert.ok(PKG.scripts.test.includes(`test/${f}`), `test/${f} exists but is not in the npm test script`);
    }
  });
});
