/**
 * AgentGuard — node-hook integration tests
 *
 * Exercises the runtime hook by spawning `node --require src/node-hook.cjs`
 * subprocesses that call various child_process APIs.  We assert against:
 *   1. The subprocess stdout (commands actually ran when expected).
 *   2. stats.commandsSeen on a real daemon (the hook actually routed through us).
 *
 * The wrapper binary at shell-wrapper/agentguard-shell must be built; tests
 * skip otherwise so CI without Go still runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startShellDaemon } from "../src/shell-daemon.js";

const REPO_ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH  = path.join(REPO_ROOT, "src", "node-hook.cjs");
const WRAPPER    = path.join(REPO_ROOT, "shell-wrapper", "agentguard-shell");

const wrapperBuilt = (() => {
  try {
    const st = fs.statSync(WRAPPER);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
})();

// macOS has a 104-byte limit on Unix socket paths.  Keep labels short and
// the suffix compact (a single random hex chunk instead of pid + epoch).
function uniqueSocketPath(label) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `ag-${label}-${suffix}.sock`);
}

function nullTtyLock() {
  return { canPrompt: false, acquire: async () => {}, release: () => {} };
}

/** Run `node --require <hook> -e <code>` and capture exit/stdout/stderr. */
function runNode(code, env, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--require", HOOK_PATH, "-e", code], { env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} resolve({ code: "TIMEOUT", out, err }); }, timeoutMs);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/**
 * Spin up a daemon, run a Node subprocess with the hook and a populated
 * AGENTGUARD env, return { result, stats } so tests can assert on both
 * subprocess output and daemon side-effects.
 */
async function withHookedNode(label, code, extraEnv = {}) {
  const socketPath = uniqueSocketPath(label);
  const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
  const daemon = await startShellDaemon({
    socketPath,
    config: {},
    agent: "hook-test",
    stats,
    ttyLock: nullTtyLock(),
  });
  const env = {
    ...process.env,
    AGENTGUARD_SOCKET: socketPath,
    AGENTGUARD_SESSION_ID: `hook-test-${label}`,
    ...extraEnv,
  };
  try {
    const result = await runNode(code, env);
    return { result, stats };
  } finally {
    await daemon.stop();
  }
}

const skipIfNoWrapper = !wrapperBuilt && "Go wrapper binary not built — skipping";

// ─── 1. No-op without session ────────────────────────────────────────────────

describe("node-hook: no-op without AGENTGUARD_SOCKET", () => {
  it(
    "exec works normally and bypasses the hook entirely",
    { skip: skipIfNoWrapper },
    async () => {
      const env = { ...process.env };
      delete env.AGENTGUARD_SOCKET;
      delete env.AGENTGUARD_SESSION_ID;
      const r = await runNode(
        `process.stdout.write(require("child_process").execSync("echo BYPASSED").toString());`,
        env
      );
      assert.equal(r.code, 0, "subprocess exited cleanly");
      assert.match(r.out, /BYPASSED/, "command ran via real /bin/sh");
    }
  );
});

// ─── 2. exec routes through daemon ───────────────────────────────────────────

describe("node-hook: child_process.exec", () => {
  it(
    "execSync('echo HOOK_OK') hits the daemon",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "exec",
        `console.log(require("child_process").execSync("echo HOOK_OK").toString().trim());`
      );
      assert.equal(result.code, 0, `exit 0; stderr was: ${result.err}`);
      assert.match(result.out, /HOOK_OK/, "wrapped exec returned the echo output");
      assert.equal(stats.commandsSeen, 1, "daemon saw exactly one request");
    }
  );

  it(
    "async exec() also hits the daemon",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "exec-async",
        `
        const cp = require("child_process");
        cp.exec("echo ASYNC_OK", (err, stdout) => {
          if (err) { console.error("ERR", err.message); process.exit(2); }
          process.stdout.write(stdout);
        });
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /ASYNC_OK/);
      assert.equal(stats.commandsSeen, 1);
    }
  );
});

// ─── 3. spawn with shell:true ────────────────────────────────────────────────

describe("node-hook: child_process.spawn({shell:true})", () => {
  it(
    "spawn with shell:true routes through the daemon",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "spawn-shell-true",
        `
        const { spawnSync } = require("child_process");
        const r = spawnSync("echo SHELL_TRUE", { shell: true, encoding: "utf8" });
        process.stdout.write(r.stdout || "");
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /SHELL_TRUE/);
      assert.equal(stats.commandsSeen, 1);
    }
  );
});

// ─── 4. Direct spawn('/bin/sh', ['-c', cmd]) ─────────────────────────────────

describe("node-hook: direct spawn('/bin/sh', ['-c', cmd])", () => {
  it(
    "intercepts the no-options direct shell invocation",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "direct-sh",
        `
        const { spawnSync } = require("child_process");
        const r = spawnSync("/bin/sh", ["-c", "echo DIRECT_SH"], { encoding: "utf8" });
        process.stdout.write(r.stdout || "");
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /DIRECT_SH/);
      assert.equal(stats.commandsSeen, 1);
    }
  );

  it(
    "also intercepts unqualified spawn('sh', ['-c', cmd])",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "direct-sh-unq",
        `
        const { spawnSync } = require("child_process");
        const r = spawnSync("sh", ["-c", "echo UNQ_SH"], { encoding: "utf8" });
        process.stdout.write(r.stdout || "");
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /UNQ_SH/);
      assert.equal(stats.commandsSeen, 1);
    }
  );
});

// ─── 5. Explicit shell:'/bin/bash' is respected ──────────────────────────────

describe("node-hook: explicit shell path", () => {
  it(
    "shell:'/bin/bash' is left alone — daemon NOT contacted",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "explicit-bash",
        `
        const { spawnSync } = require("child_process");
        const r = spawnSync("echo EXPLICIT_BASH", {
          shell: "/bin/bash",
          encoding: "utf8",
        });
        process.stdout.write(r.stdout || "");
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /EXPLICIT_BASH/, "bash ran the command");
      assert.equal(stats.commandsSeen, 0, "daemon was not contacted (Decision 1)");
    }
  );
});

// ─── 6. Custom options.env still routes through daemon ───────────────────────

describe("node-hook: custom options.env env-injection", () => {
  it(
    "exec with options.env={} still reaches the daemon (re-injection)",
    { skip: skipIfNoWrapper },
    async () => {
      const { result, stats } = await withHookedNode(
        "custom-env",
        `
        const { execSync } = require("child_process");
        // Empty env clobbers AGENTGUARD_SOCKET — without re-injection the
        // wrapper would fall back to passthrough and the daemon would never
        // see the request.
        const out = execSync("echo CLEAN_ENV", { env: {}, encoding: "utf8" });
        process.stdout.write(out);
        `
      );
      assert.equal(result.code, 0);
      assert.match(result.out, /CLEAN_ENV/);
      assert.equal(stats.commandsSeen, 1, "daemon saw the request via re-injected env");
    }
  );
});

// ─── 7. Risky command → wrapper exits 126 → exec/spawn surfaces failure ──────

describe("node-hook: risky command propagates deny", () => {
  it(
    "execSync of a CRITICAL command throws with exit 126 (autoDeny via no-TTY)",
    { skip: skipIfNoWrapper },
    async () => {
      // Daemon's shellRuntime treats CRITICAL+canPrompt=false as deny.  The
      // wrapper exits 126; execSync surfaces this as a thrown error with
      // status === 126.
      const { result, stats } = await withHookedNode(
        "risky",
        `
        const { execSync } = require("child_process");
        try {
          execSync("rm -rf /tmp/agentguard-hook-test-target");
          console.log("UNEXPECTED_SUCCESS");
        } catch (e) {
          console.log("STATUS", e.status);
        }
        `
      );
      assert.equal(result.code, 0, "test process itself exited 0");
      assert.match(result.out, /STATUS 126/, "execSync threw with exit 126");
      assert.ok((stats.blocked.CRITICAL ?? 0) >= 1, "daemon counted the deny");
    }
  );
});
