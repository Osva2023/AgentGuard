/**
 * AgentGuard — PTY session registry + termination tests (TASK-029)
 *
 * Run with:
 *   node --test test/pty-registry.test.js
 *
 * Verifies the disk registry (register / unregister / list) and the daemon-side
 * terminatePtySessions() sequence: SIGTERM to every live session → grace →
 * SIGKILL survivors → prune. All processes are mocked (signal / liveness / sleep
 * seams) so nothing real is ever signalled and no real delay is incurred.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  registerPtySession,
  unregisterPtySession,
  listPtySessions,
  terminatePtySessions,
} from "../src/pty-registry.js";

// ─── temp registry dir per test ────────────────────────────────────────────────

let dir;
beforeEach(() => {
  dir = path.join(os.tmpdir(), `ag-pty-${crypto.randomBytes(6).toString("hex")}`);
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

// ─── register / unregister / list ──────────────────────────────────────────────

describe("registry — register / list / unregister", () => {
  it("registers a session and lists it back", () => {
    const file = registerPtySession({ pid: 4242, cwd: "/w/BeachFlags", agent: "claude", sessionId: "abcd", dir });
    assert.ok(file && fs.existsSync(file));
    const sessions = listPtySessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pid, 4242);
    assert.equal(sessions[0].cwd, "/w/BeachFlags");
    assert.equal(sessions[0].agent, "claude");
  });

  it("unregister removes the entry", () => {
    registerPtySession({ pid: 4242, dir });
    unregisterPtySession(4242, dir);
    assert.deepEqual(listPtySessions(dir), []);
  });

  it("register returns null for a non-finite pid", () => {
    assert.equal(registerPtySession({ pid: undefined, dir }), null);
  });

  it("list returns [] when the directory does not exist", () => {
    assert.deepEqual(listPtySessions(path.join(dir, "nope")), []);
  });

  it("list skips malformed entries", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "999.json"), "{not json");
    registerPtySession({ pid: 4242, dir });
    const sessions = listPtySessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].pid, 4242);
  });

  it("unregister never throws on a missing entry", () => {
    assert.doesNotThrow(() => unregisterPtySession(123456, dir));
  });
});

// ─── mock harness for terminatePtySessions ──────────────────────────────────────

/** Build signal/liveness/sleep seams over a recorded event log. */
function harness({ alive, diesOnTerm = new Set() }) {
  const events = [];
  const aliveSet = new Set(alive);
  return {
    events,
    aliveSet,
    signalFn: (pid, signal) => {
      events.push(`${signal}:${pid}`);
      if (signal === "SIGTERM" && diesOnTerm.has(pid)) aliveSet.delete(pid);
      if (signal === "SIGKILL") aliveSet.delete(pid);
    },
    isAliveFn: (pid) => aliveSet.has(pid),
    sleepFn: async (ms) => { events.push(`sleep:${ms}`); },
  };
}

// ─── terminatePtySessions ───────────────────────────────────────────────────────

describe("terminatePtySessions — no sessions", () => {
  it("returns zero and signals nothing on an empty registry", async () => {
    const h = harness({ alive: [] });
    const res = await terminatePtySessions({ dir, ...h, selfPid: 1 });
    assert.deepEqual(res, { terminated: 0, killed: 0, pids: [] });
    assert.deepEqual(h.events, []);
  });
});

describe("terminatePtySessions — SIGTERM then grace then SIGKILL", () => {
  it("SIGTERMs every live session and stays silent on clean exit", async () => {
    registerPtySession({ pid: 5001, dir });
    registerPtySession({ pid: 5002, dir });
    // Both exit cleanly on SIGTERM.
    const h = harness({ alive: [5001, 5002], diesOnTerm: new Set([5001, 5002]) });
    let logged = null;
    const res = await terminatePtySessions({ dir, ...h, selfPid: 1, log: (m) => { logged = m; } });

    assert.equal(res.terminated, 2);
    assert.equal(res.killed, 0);
    // Both SIGTERMs precede the grace sleep; no SIGKILL needed.
    assert.ok(h.events.includes("SIGTERM:5001"));
    assert.ok(h.events.includes("SIGTERM:5002"));
    assert.ok(!h.events.some((e) => e.startsWith("SIGKILL")));
    const sleepIdx = h.events.indexOf("sleep:2000");
    assert.ok(sleepIdx > -1, "should wait the grace period");
    assert.ok(h.events.indexOf("SIGTERM:5001") < sleepIdx, "SIGTERM before grace");
    assert.ok(h.events.indexOf("SIGTERM:5002") < sleepIdx, "SIGTERM before grace");
    // Registry pruned.
    assert.deepEqual(listPtySessions(dir), []);
    assert.match(logged, /terminated 2 active PTY sessions/);
  });

  it("SIGKILLs only the survivor after the grace period", async () => {
    registerPtySession({ pid: 6001, dir });
    registerPtySession({ pid: 6002, dir });
    // 6001 exits on SIGTERM; 6002 ignores it and must be SIGKILLed.
    const h = harness({ alive: [6001, 6002], diesOnTerm: new Set([6001]) });
    let logged = null;
    const res = await terminatePtySessions({ dir, ...h, selfPid: 1, log: (m) => { logged = m; } });

    assert.equal(res.terminated, 2);
    assert.equal(res.killed, 1);
    // SIGKILL goes only to the survivor, and only after the grace sleep.
    const killIdx = h.events.indexOf("SIGKILL:6002");
    const sleepIdx = h.events.indexOf("sleep:2000");
    assert.ok(killIdx > sleepIdx, "SIGKILL must follow the grace period");
    assert.ok(!h.events.includes("SIGKILL:6001"), "the clean-exit session is not SIGKILLed");
    assert.match(logged, /1 required SIGKILL/);
  });
});

describe("terminatePtySessions — skips self and prunes stale", () => {
  it("never signals selfPid", async () => {
    registerPtySession({ pid: 7777, dir });
    const h = harness({ alive: [7777] });
    const res = await terminatePtySessions({ dir, ...h, selfPid: 7777 });
    assert.equal(res.terminated, 0);
    assert.deepEqual(h.events, []);
    // Own entry is left untouched.
    assert.equal(listPtySessions(dir).length, 1);
  });

  it("prunes dead entries without signalling them", async () => {
    registerPtySession({ pid: 8001, dir }); // dead
    registerPtySession({ pid: 8002, dir }); // alive
    const h = harness({ alive: [8002], diesOnTerm: new Set([8002]) });
    const res = await terminatePtySessions({ dir, ...h, selfPid: 1 });

    assert.equal(res.terminated, 1);
    assert.deepEqual(res.pids, [8002]);
    assert.ok(!h.events.some((e) => e.includes("8001")), "dead pid is never signalled");
    assert.deepEqual(listPtySessions(dir), [], "both the handled and stale entries are pruned");
  });
});
