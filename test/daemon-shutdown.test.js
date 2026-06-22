/**
 * AgentGuard — daemon ordered-shutdown tests (TASK-029)
 *
 * Run with:
 *   node --test test/daemon-shutdown.test.js
 *
 * Verifies the shutdown contract: PTY sessions are terminated FIRST, then the
 * file watchers are stopped, then the daemon finalizes — and that a failure in
 * any single step never skips the remaining ones.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shutdownSequence } from "../src/daemon-shutdown.js";

describe("shutdownSequence — ordering", () => {
  it("runs terminate-pty → stop-watchers → finalize in order", async () => {
    const calls = [];
    const { order } = await shutdownSequence({
      terminatePty: async () => { calls.push("pty"); return { terminated: 3, killed: 1 }; },
      stopWatchers: async () => { calls.push("watchers"); },
      finalize: async () => { calls.push("finalize"); },
    });
    assert.deepEqual(calls, ["pty", "watchers", "finalize"]);
    assert.deepEqual(order, ["terminate-pty", "stop-watchers", "finalize"]);
  });

  it("waits for an async terminate-pty before stopping watchers", async () => {
    const calls = [];
    await shutdownSequence({
      terminatePty: () =>
        new Promise((resolve) => {
          setTimeout(() => { calls.push("pty"); resolve({ terminated: 1, killed: 0 }); }, 5);
        }),
      stopWatchers: () => { calls.push("watchers"); },
      finalize: () => { calls.push("finalize"); },
    });
    assert.deepEqual(calls, ["pty", "watchers", "finalize"], "watchers must wait for PTY teardown");
  });

  it("returns the PTY termination result for reporting", async () => {
    const { pty } = await shutdownSequence({
      terminatePty: async () => ({ terminated: 2, killed: 1 }),
      stopWatchers: () => {},
      finalize: () => {},
    });
    assert.deepEqual(pty, { terminated: 2, killed: 1 });
  });
});

describe("shutdownSequence — resilience", () => {
  it("still stops watchers and finalizes when terminate-pty throws", async () => {
    const calls = [];
    const logs = [];
    const { order } = await shutdownSequence({
      terminatePty: async () => { throw new Error("boom"); },
      stopWatchers: () => { calls.push("watchers"); },
      finalize: () => { calls.push("finalize"); },
      log: (m) => logs.push(m),
    });
    assert.deepEqual(calls, ["watchers", "finalize"]);
    assert.deepEqual(order, ["terminate-pty", "stop-watchers", "finalize"]);
    assert.ok(logs.some((m) => /PTY termination error: boom/.test(m)));
  });

  it("still finalizes when stop-watchers throws", async () => {
    const calls = [];
    await shutdownSequence({
      terminatePty: async () => ({ terminated: 0, killed: 0 }),
      stopWatchers: () => { throw new Error("watch fail"); },
      finalize: () => { calls.push("finalize"); },
    });
    assert.deepEqual(calls, ["finalize"]);
  });

  it("defaults the PTY result when terminate-pty returns nothing", async () => {
    const { pty } = await shutdownSequence({
      terminatePty: () => undefined,
      stopWatchers: () => {},
      finalize: () => {},
    });
    assert.deepEqual(pty, { terminated: 0, killed: 0 });
  });
});
