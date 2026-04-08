/**
 * AgentGuard — decoder unit tests
 *
 * Run with:
 *   node --test test/decoder.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeCommand, decodeFileEvent, EVENT_TYPES } from "../src/decoder.js";

// ─── decodeCommand ────────────────────────────────────────────────────────────

describe("decodeCommand()", () => {
  // ── prompt-style extraction ──────────────────────────────────────────────────

  describe("prompt-style prefixes", () => {
    it("extracts command from '$ ...' prefix", () => {
      const evt = decodeCommand("$ rm -rf tmp");
      assert.ok(evt !== null);
      assert.equal(evt.command, "rm -rf tmp");
    });

    it("extracts command from '% ...' prefix", () => {
      const evt = decodeCommand("% git status");
      assert.ok(evt !== null);
      assert.equal(evt.command, "git status");
    });

    it("extracts command from '# ...' prefix", () => {
      const evt = decodeCommand("# whoami");
      assert.ok(evt !== null);
      assert.equal(evt.command, "whoami");
    });

    it("extracts command from '> ...' prefix", () => {
      const evt = decodeCommand("> echo hello");
      assert.ok(evt !== null);
      assert.equal(evt.command, "echo hello");
    });

    it("trims surrounding whitespace from the extracted command", () => {
      const evt = decodeCommand("$   ls -la  ");
      assert.ok(evt !== null);
      assert.equal(evt.command, "ls -la");
    });
  });

  // ── agent-annotation extraction ──────────────────────────────────────────────

  describe("agent-annotation prefixes", () => {
    it("extracts command from 'Running: ...' annotation", () => {
      const evt = decodeCommand("Running: git push --force");
      assert.ok(evt !== null);
      assert.equal(evt.command, "git push --force");
    });

    it("extracts command from 'Executing: ...' annotation", () => {
      const evt = decodeCommand("Executing: npm install lodash");
      assert.ok(evt !== null);
      assert.equal(evt.command, "npm install lodash");
    });

    it("extracts command from 'Exec: ...' annotation", () => {
      const evt = decodeCommand("Exec: curl https://example.com");
      assert.ok(evt !== null);
      assert.equal(evt.command, "curl https://example.com");
    });

    it("extracts command from 'Run: ...' annotation (case-insensitive)", () => {
      const evt = decodeCommand("run: echo test");
      assert.ok(evt !== null);
      assert.equal(evt.command, "echo test");
    });
  });

  // ── null returns ─────────────────────────────────────────────────────────────

  describe("non-command lines return null", () => {
    it("returns null for plain log output", () => {
      assert.equal(decodeCommand("Starting server on port 3000"), null);
    });

    it("returns null for an empty string", () => {
      assert.equal(decodeCommand(""), null);
    });

    it("returns null for a blank/whitespace line", () => {
      assert.equal(decodeCommand("   "), null);
    });

    it("returns null for output that looks like a progress bar", () => {
      assert.equal(decodeCommand("████████░░░░  60%"), null);
    });

    it("returns null for a JSON log line", () => {
      assert.equal(decodeCommand('{"level":"info","msg":"ready"}'), null);
    });
  });

  // ── event shape ──────────────────────────────────────────────────────────────

  describe("event shape", () => {
    it("type is process_exec", () => {
      const evt = decodeCommand("$ echo hi");
      assert.equal(evt.type, EVENT_TYPES.PROCESS_EXEC);
    });

    it("raw preserves the original line", () => {
      const line = "$ git status";
      const evt = decodeCommand(line);
      assert.equal(evt.raw, line);
    });

    it("time is a valid ISO 8601 string", () => {
      const evt = decodeCommand("$ ls");
      assert.ok(typeof evt.time === "string");
      assert.ok(!isNaN(Date.parse(evt.time)));
    });

    it("time is close to now (within 1 second)", () => {
      const before = Date.now();
      const evt = decodeCommand("$ ls");
      const after = Date.now();
      const t = Date.parse(evt.time);
      assert.ok(t >= before && t <= after + 1000);
    });
  });

  // ── command subtype detection ─────────────────────────────────────────────────

  describe("subtype detection", () => {
    it("git_operation — git command", () => {
      const evt = decodeCommand("$ git push --force");
      assert.equal(evt.subtype, "git_operation");
    });

    it("file_delete — rm command", () => {
      const evt = decodeCommand("$ rm -rf dist");
      assert.equal(evt.subtype, "file_delete");
    });

    it("file_delete — unlink command", () => {
      const evt = decodeCommand("$ unlink old.sock");
      assert.equal(evt.subtype, "file_delete");
    });

    it("network_request — curl command", () => {
      const evt = decodeCommand("$ curl https://example.com");
      assert.equal(evt.subtype, "network_request");
    });

    it("network_request — wget command", () => {
      const evt = decodeCommand("$ wget https://example.com/file.tar.gz");
      assert.equal(evt.subtype, "network_request");
    });

    it("shell_exec — pipe to bash", () => {
      // Use 'cat' (not curl/wget) so network_request doesn't fire first
      const evt = decodeCommand("$ cat install.sh | bash");
      assert.equal(evt.subtype, "shell_exec");
    });

    it("shell_exec — eval", () => {
      // Avoid brew/npm so package_install doesn't fire first
      const evt = decodeCommand("$ eval \"$(cat /etc/passwd)\"");
      assert.equal(evt.subtype, "shell_exec");
    });

    it("file_write — redirect into a file", () => {
      const evt = decodeCommand("$ echo secret > .env");
      assert.equal(evt.subtype, "file_write");
    });

    it("file_write — tee command", () => {
      const evt = decodeCommand("$ cat config.txt | tee output.txt");
      assert.equal(evt.subtype, "file_write");
    });

    it("generic — plain command with no recognised pattern", () => {
      const evt = decodeCommand("$ echo hello world");
      assert.equal(evt.subtype, "generic");
    });

    it("git_operation takes precedence over file_delete when both words present", () => {
      // 'git rm' contains both 'git' and 'rm'; git_operation rule is listed first
      const evt = decodeCommand("$ git rm --cached secrets.txt");
      assert.equal(evt.subtype, "git_operation");
    });
  });
});

// ─── decodeFileEvent ──────────────────────────────────────────────────────────

describe("decodeFileEvent()", () => {
  // ── event type mapping ───────────────────────────────────────────────────────

  describe("chokidar event → canonical type", () => {
    it('"change" maps to file_write', () => {
      const evt = decodeFileEvent("change", "src/app.js");
      assert.equal(evt.type, EVENT_TYPES.FILE_WRITE);
    });

    it('"add" maps to file_write', () => {
      const evt = decodeFileEvent("add", "newfile.js");
      assert.equal(evt.type, EVENT_TYPES.FILE_WRITE);
    });

    it('"unlink" maps to file_delete', () => {
      const evt = decodeFileEvent("unlink", "old.js");
      assert.equal(evt.type, EVENT_TYPES.FILE_DELETE);
    });
  });

  // ── file subtype detection ───────────────────────────────────────────────────

  describe("file subtype detection", () => {
    it('"change" on ".env" → file_write + subtype secret', () => {
      const evt = decodeFileEvent("change", ".env");
      assert.equal(evt.type, EVENT_TYPES.FILE_WRITE);
      assert.equal(evt.subtype, "secret");
    });

    it('"change" on ".env.production" → subtype secret', () => {
      const evt = decodeFileEvent("change", ".env.production");
      assert.equal(evt.subtype, "secret");
    });

    it('"unlink" on ".github/workflows/deploy.yml" → file_delete + subtype cicd', () => {
      const evt = decodeFileEvent("unlink", ".github/workflows/deploy.yml");
      assert.equal(evt.type, EVENT_TYPES.FILE_DELETE);
      assert.equal(evt.subtype, "cicd");
    });

    it('"add" on "package.json" → file_write + subtype dependency', () => {
      const evt = decodeFileEvent("add", "package.json");
      assert.equal(evt.type, EVENT_TYPES.FILE_WRITE);
      assert.equal(evt.subtype, "dependency");
    });

    it('"add" on "package-lock.json" → subtype dependency', () => {
      const evt = decodeFileEvent("add", "package-lock.json");
      assert.equal(evt.subtype, "dependency");
    });

    it('"change" on "src/app.js" → file_write + subtype source', () => {
      const evt = decodeFileEvent("change", "src/app.js");
      assert.equal(evt.type, EVENT_TYPES.FILE_WRITE);
      assert.equal(evt.subtype, "source");
    });

    it('"change" on a .ts file → subtype source', () => {
      const evt = decodeFileEvent("change", "src/index.ts");
      assert.equal(evt.subtype, "source");
    });

    it('"change" on a .py file → subtype source', () => {
      const evt = decodeFileEvent("change", "scripts/migrate.py");
      assert.equal(evt.subtype, "source");
    });

    it("unknown file path → subtype generic", () => {
      const evt = decodeFileEvent("change", "notes.txt");
      assert.equal(evt.subtype, "generic");
    });

    it("deeply nested unknown file → subtype generic", () => {
      const evt = decodeFileEvent("add", "some/nested/path/data.csv");
      assert.equal(evt.subtype, "generic");
    });

    it("cicd takes precedence over config for a .yml file under .github/workflows", () => {
      const evt = decodeFileEvent("change", ".github/workflows/ci.yml");
      assert.equal(evt.subtype, "cicd");
    });

    it('"change" on "id_rsa" → subtype secret', () => {
      const evt = decodeFileEvent("change", "id_rsa");
      assert.equal(evt.subtype, "secret");
    });

    it('"change" on "server.pem" → subtype secret', () => {
      const evt = decodeFileEvent("change", "server.pem");
      assert.equal(evt.subtype, "secret");
    });

    it('"change" on "Dockerfile" → subtype config', () => {
      const evt = decodeFileEvent("change", "Dockerfile");
      assert.equal(evt.subtype, "config");
    });
  });

  // ── event shape ──────────────────────────────────────────────────────────────

  describe("event shape", () => {
    it("file field equals the provided path", () => {
      const evt = decodeFileEvent("change", "src/app.js");
      assert.equal(evt.file, "src/app.js");
    });

    it("raw field equals the provided path", () => {
      const evt = decodeFileEvent("add", "package.json");
      assert.equal(evt.raw, "package.json");
    });

    it("time is a valid ISO 8601 string", () => {
      const evt = decodeFileEvent("change", "README.md");
      assert.ok(typeof evt.time === "string");
      assert.ok(!isNaN(Date.parse(evt.time)));
    });

    it("time is close to now (within 1 second)", () => {
      const before = Date.now();
      const evt = decodeFileEvent("change", "README.md");
      const after = Date.now();
      const t = Date.parse(evt.time);
      assert.ok(t >= before && t <= after + 1000);
    });
  });
});
