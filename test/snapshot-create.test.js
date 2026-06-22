/**
 * AgentGuard — createSnapshot timeout / non-blocking tests (TASK-025)
 *
 * Run with:
 *   node --test test/snapshot-create.test.js
 *
 * createSnapshot() runs `git stash` synchronously at session start.  On a large
 * or slow repo that stash could take several seconds and make AgentGuard appear
 * to hang on session start/close.  These tests verify it is bounded by a short
 * timeout and degrades gracefully (created:false, timedOut:true) instead of
 * blocking — exercised through the injectable spawnFn seam, no real git needed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createSnapshot, SNAPSHOT_TIMEOUT_MS } from "../src/snapshot.js";

// ─── fake spawnSync ───────────────────────────────────────────────────────────

/**
 * Build a fake spawnFn that answers the two git invocations createSnapshot
 * makes: `rev-parse --is-inside-work-tree` (repo check) and `stash -u -m ...`.
 * `stashResult` is what the stash call returns.  Every call is recorded.
 */
function fakeSpawn({ isRepo = true, stashResult } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === "rev-parse") {
      return isRepo ? { status: 0 } : { status: 128, error: undefined };
    }
    if (args[0] === "stash") {
      return stashResult;
    }
    return { status: 0 };
  };
  fn.calls = calls;
  return fn;
}

const SAVED_OK = {
  status: 0,
  stdout: "Saved working directory and index state On main: agentguard-snapshot-x",
  stderr: "",
};

function timeoutResult() {
  const error = new Error("spawnSync git ETIMEDOUT");
  error.code = "ETIMEDOUT";
  return { status: null, signal: "SIGTERM", error, stdout: "", stderr: "" };
}

// An empty temp dir keeps backupSensitiveFiles() fast (no sensitive files to copy).
let emptyDir;
before(() => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-snap-"));
});
after(() => {
  try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe("SNAPSHOT_TIMEOUT_MS", () => {
  it("defaults to 2000ms", () => {
    assert.equal(SNAPSHOT_TIMEOUT_MS, 2000);
  });
});

describe("createSnapshot — success path", () => {
  it("returns created:true with a stashRef when git stash succeeds", () => {
    const spawnFn = fakeSpawn({ stashResult: SAVED_OK });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.created, true);
    assert.ok(snap.stashRef?.startsWith("agentguard-snapshot-"));
    assert.equal(snap.timedOut, undefined);
  });
});

describe("createSnapshot — timeout is non-blocking", () => {
  it("returns created:false + timedOut:true when git stash times out", () => {
    const spawnFn = fakeSpawn({ stashResult: timeoutResult() });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.created, false);
    assert.equal(snap.timedOut, true);
    assert.equal(snap.stashRef, null);
  });

  it("the timeout message names the budget and says it continued", () => {
    const spawnFn = fakeSpawn({ stashResult: timeoutResult() });
    const snap = createSnapshot({ cwd: emptyDir, timeoutMs: 2000, spawnFn });
    assert.match(snap.message, /2000ms/);
    assert.match(snap.message, /without blocking/i);
  });

  it("also treats a bare SIGTERM (no ETIMEDOUT code) as a timeout", () => {
    const result = { status: null, signal: "SIGTERM", error: new Error("killed"), stdout: "", stderr: "" };
    const spawnFn = fakeSpawn({ stashResult: result });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.timedOut, true);
  });
});

describe("createSnapshot — timeout budget propagation", () => {
  it("passes the default 2000ms timeout to the git stash spawn", () => {
    const spawnFn = fakeSpawn({ stashResult: SAVED_OK });
    createSnapshot({ cwd: emptyDir, spawnFn });
    const stashCall = spawnFn.calls.find((c) => c.args[0] === "stash");
    assert.equal(stashCall.opts.timeout, 2000);
  });

  it("honors a custom timeoutMs", () => {
    const spawnFn = fakeSpawn({ stashResult: SAVED_OK });
    createSnapshot({ cwd: emptyDir, timeoutMs: 500, spawnFn });
    const stashCall = spawnFn.calls.find((c) => c.args[0] === "stash");
    assert.equal(stashCall.opts.timeout, 500);
  });
});

describe("createSnapshot — other outcomes still work", () => {
  it("returns created:false (clean) when there are no local changes", () => {
    const clean = { status: 0, stdout: "No local changes to save", stderr: "" };
    const spawnFn = fakeSpawn({ stashResult: clean });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.created, false);
    assert.equal(snap.timedOut, undefined);
    assert.match(snap.message, /clean/i);
  });

  it("returns created:false when git stash exits non-zero (non-timeout failure)", () => {
    const failed = { status: 1, stdout: "", stderr: "fatal: something broke" };
    const spawnFn = fakeSpawn({ stashResult: failed });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.created, false);
    assert.equal(snap.timedOut, undefined);
    assert.match(snap.message, /git exit 1/);
  });

  it("skips the stash entirely when cwd is not a git repo", () => {
    const spawnFn = fakeSpawn({ isRepo: false, stashResult: SAVED_OK });
    const snap = createSnapshot({ cwd: emptyDir, spawnFn });
    assert.equal(snap.created, false);
    assert.match(snap.message, /Not a git repository/);
    // Repo check ran, stash never did.
    assert.ok(!spawnFn.calls.some((c) => c.args[0] === "stash"));
  });
});
