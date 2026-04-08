/**
 * AgentGuard — enforcement unit tests
 *
 * Run with:
 *   node --test test/enforcement.test.js
 *
 * All logger I/O is suppressed by redirecting the log file to /dev/null via
 * a LOG_FILE override.  promptApproval and runtime callbacks are injected
 * stubs — no child processes, no PTY, no FS writes beyond the audit log.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleIncident } from "../src/enforcement.js";

// ─── Silence audit-log writes ──────────────────────────────────────────────────
// The logger always attempts to append to ~/.agentguard/audit.log.
// We can't easily redirect it without mocking the fs module, but the logger
// is designed to swallow its own errors, so test runs that lack a home
// directory writeable path will just emit a stderr notice and continue.
// Nothing in these tests asserts on the audit-log file.

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Incident.  All fields that handleIncident cares about can
 * be overridden via `overrides`.
 */
function makeIncident(overrides = {}) {
  return {
    source: "command",
    level: "HIGH",
    reason: "Dangerous operation detected",
    command: "rm -rf tmp",
    ...overrides,
  };
}

/**
 * Build a minimal config object.
 * Pass `{ autoDeny: ["CRITICAL"] }` etc. to exercise specific branches.
 */
function makeConfig(overrides = {}) {
  return {
    autoApprove: [],
    autoDeny: [],
    snapshot: { enabled: true, restoreOnDeny: true },
    ...overrides,
  };
}

/**
 * Build a runtime object with all callbacks as no-op stubs.
 * Pass `overrides` to replace specific callbacks or set canPrompt.
 */
function makeRuntime(overrides = {}) {
  return {
    canPrompt: true,
    prompt: async () => "approve",   // safe default; override per test
    onRestore: () => {},
    onTerminate: () => {},
    onResume: () => {},
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleIncident()", () => {

  // ── autoApprove ─────────────────────────────────────────────────────────────

  describe("autoApprove path", () => {
    it("returns outcome=approved when level is in config.autoApprove", async () => {
      const result = await handleIncident({
        incident: makeIncident({ level: "WARN" }),
        config: makeConfig({ autoApprove: ["WARN"] }),
        runtime: makeRuntime(),
      });
      assert.equal(result.outcome, "approved");
    });

    it("echoes the incident back in the result", async () => {
      const incident = makeIncident({ level: "WARN" });
      const result = await handleIncident({
        incident,
        config: makeConfig({ autoApprove: ["WARN"] }),
        runtime: makeRuntime(),
      });
      assert.strictEqual(result.incident, incident);
    });

    it("does not call onTerminate on autoApprove", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident({ level: "WARN" }),
        config: makeConfig({ autoApprove: ["WARN"] }),
        runtime: makeRuntime({ onTerminate: () => { terminated = true; } }),
      });
      assert.equal(terminated, false);
    });

    it("calls onResume on autoApprove", async () => {
      let resumed = false;
      await handleIncident({
        incident: makeIncident({ level: "WARN" }),
        config: makeConfig({ autoApprove: ["WARN"] }),
        runtime: makeRuntime({ onResume: () => { resumed = true; } }),
      });
      assert.equal(resumed, true);
    });

    it("increments stats.approved on autoApprove", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      await handleIncident({
        incident: makeIncident({ level: "WARN" }),
        config: makeConfig({ autoApprove: ["WARN"] }),
        stats,
        runtime: makeRuntime(),
      });
      assert.equal(stats.approved, 1);
    });

    it("does not call prompt on autoApprove", async () => {
      let prompted = false;
      await handleIncident({
        incident: makeIncident({ level: "WARN" }),
        config: makeConfig({ autoApprove: ["WARN"] }),
        runtime: makeRuntime({ prompt: async () => { prompted = true; return "approve"; } }),
      });
      assert.equal(prompted, false);
    });
  });

  // ── autoDeny ────────────────────────────────────────────────────────────────

  describe("autoDeny path", () => {
    it("returns outcome=denied when level is in config.autoDeny", async () => {
      const result = await handleIncident({
        incident: makeIncident({ level: "CRITICAL" }),
        config: makeConfig({ autoDeny: ["CRITICAL"] }),
        runtime: makeRuntime({ onTerminate: () => {} }),
      });
      assert.equal(result.outcome, "denied");
    });

    it("calls onTerminate on autoDeny", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident({ level: "CRITICAL" }),
        config: makeConfig({ autoDeny: ["CRITICAL"] }),
        runtime: makeRuntime({ onTerminate: () => { terminated = true; } }),
      });
      assert.equal(terminated, true);
    });

    it("does not call onResume on autoDeny", async () => {
      let resumed = false;
      await handleIncident({
        incident: makeIncident({ level: "CRITICAL" }),
        config: makeConfig({ autoDeny: ["CRITICAL"] }),
        runtime: makeRuntime({
          onTerminate: () => {},
          onResume: () => { resumed = true; },
        }),
      });
      assert.equal(resumed, false);
    });

    it("increments stats.blocked by level on autoDeny", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      await handleIncident({
        incident: makeIncident({ level: "CRITICAL" }),
        config: makeConfig({ autoDeny: ["CRITICAL"] }),
        stats,
        runtime: makeRuntime({ onTerminate: () => {} }),
      });
      assert.equal(stats.blocked["CRITICAL"], 1);
    });

    it("does not call prompt on autoDeny", async () => {
      let prompted = false;
      await handleIncident({
        incident: makeIncident({ level: "CRITICAL" }),
        config: makeConfig({ autoDeny: ["CRITICAL"] }),
        runtime: makeRuntime({
          onTerminate: () => {},
          prompt: async () => { prompted = true; return "deny"; },
        }),
      });
      assert.equal(prompted, false);
    });

    it("autoDeny takes precedence over autoApprove for the same level", async () => {
      // If a level appears in both lists, deny wins (deny is checked first).
      const result = await handleIncident({
        incident: makeIncident({ level: "HIGH" }),
        config: makeConfig({ autoDeny: ["HIGH"], autoApprove: ["HIGH"] }),
        runtime: makeRuntime({ onTerminate: () => {} }),
      });
      assert.equal(result.outcome, "denied");
    });
  });

  // ── prompt → approve ────────────────────────────────────────────────────────

  describe("prompt then approve", () => {
    it("returns outcome=approved when prompt resolves to approve", async () => {
      const result = await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({ prompt: async () => "approve" }),
      });
      assert.equal(result.outcome, "approved");
    });

    it("calls onResume after prompt approval", async () => {
      let resumed = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "approve",
          onResume: () => { resumed = true; },
        }),
      });
      assert.equal(resumed, true);
    });

    it("does not call onTerminate after prompt approval", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "approve",
          onTerminate: () => { terminated = true; },
        }),
      });
      assert.equal(terminated, false);
    });

    it("increments stats.approved on prompt approval", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        stats,
        runtime: makeRuntime({ prompt: async () => "approve" }),
      });
      assert.equal(stats.approved, 1);
    });

    it("increments stats.intercepted before prompting", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        stats,
        runtime: makeRuntime({ prompt: async () => "approve" }),
      });
      assert.equal(stats.intercepted, 1);
    });

    it("passes incident fields to the prompt function", async () => {
      let capturedArg = null;
      await handleIncident({
        incident: makeIncident({
          level: "CRITICAL",
          reason: "Secret file written",
          command: "cp .env /tmp/stolen",
          contextNotes: ["note one"],
        }),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async (arg) => { capturedArg = arg; return "approve"; },
        }),
      });
      assert.equal(capturedArg.level, "CRITICAL");
      assert.equal(capturedArg.reason, "Secret file written");
      assert.equal(capturedArg.command, "cp .env /tmp/stolen");
      assert.deepEqual(capturedArg.contextNotes, ["note one"]);
    });
  });

  // ── prompt → deny ───────────────────────────────────────────────────────────

  describe("prompt then deny", () => {
    it("returns outcome=denied when prompt resolves to deny", async () => {
      const result = await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "deny",
          onTerminate: () => {},
        }),
      });
      assert.equal(result.outcome, "denied");
    });

    it("returns outcome=denied when prompt resolves to quit", async () => {
      const result = await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "quit",
          onTerminate: () => {},
        }),
      });
      assert.equal(result.outcome, "denied");
    });

    it("calls onTerminate after prompt deny", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "deny",
          onTerminate: () => { terminated = true; },
        }),
      });
      assert.equal(terminated, true);
    });

    it("does not call onResume after prompt deny", async () => {
      let resumed = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async () => "deny",
          onTerminate: () => {},
          onResume: () => { resumed = true; },
        }),
      });
      assert.equal(resumed, false);
    });

    it("increments stats.blocked by level on prompt deny", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      await handleIncident({
        incident: makeIncident({ level: "HIGH" }),
        config: makeConfig(),
        stats,
        runtime: makeRuntime({
          prompt: async () => "deny",
          onTerminate: () => {},
        }),
      });
      assert.equal(stats.blocked["HIGH"], 1);
    });
  });

  // ── deny triggers restore ────────────────────────────────────────────────────

  describe("deny triggers restore when configured", () => {
    it("calls onRestore when stashRef is set and restoreOnDeny is true", async () => {
      let restored = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig({ snapshot: { enabled: true, restoreOnDeny: true } }),
        stashRef: "stash@{0}",
        runtime: makeRuntime({
          prompt: async () => "deny",
          onRestore: () => { restored = true; },
          onTerminate: () => {},
        }),
      });
      assert.equal(restored, true);
    });

    it("does not call onRestore when stashRef is absent", async () => {
      let restored = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig({ snapshot: { enabled: true, restoreOnDeny: true } }),
        stashRef: undefined,
        runtime: makeRuntime({
          prompt: async () => "deny",
          onRestore: () => { restored = true; },
          onTerminate: () => {},
        }),
      });
      assert.equal(restored, false);
    });

    it("does not call onRestore when restoreOnDeny is false", async () => {
      let restored = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig({ snapshot: { enabled: true, restoreOnDeny: false } }),
        stashRef: "stash@{0}",
        runtime: makeRuntime({
          prompt: async () => "deny",
          onRestore: () => { restored = true; },
          onTerminate: () => {},
        }),
      });
      assert.equal(restored, false);
    });

    it("calls onRestore before onTerminate", async () => {
      const order = [];
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        stashRef: "stash@{0}",
        runtime: makeRuntime({
          prompt: async () => "deny",
          onRestore: () => { order.push("restore"); },
          onTerminate: () => { order.push("terminate"); },
        }),
      });
      assert.deepEqual(order, ["restore", "terminate"]);
    });

    it("still calls onTerminate even when onRestore is not provided", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        stashRef: "stash@{0}",
        runtime: {
          canPrompt: true,
          prompt: async () => "deny",
          onTerminate: () => { terminated = true; },
          // onRestore deliberately omitted
        },
      });
      assert.equal(terminated, true);
    });
  });

  // ── deferred (no TTY) ────────────────────────────────────────────────────────

  describe("prompt-impossible fallback — deferred", () => {
    it("returns outcome=deferred when canPrompt is false", async () => {
      const result = await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({ canPrompt: false }),
      });
      assert.equal(result.outcome, "deferred");
    });

    it("does not call prompt when canPrompt is false", async () => {
      let prompted = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          canPrompt: false,
          prompt: async () => { prompted = true; return "approve"; },
        }),
      });
      assert.equal(prompted, false);
    });

    it("does not call onTerminate when deferred", async () => {
      let terminated = false;
      await handleIncident({
        incident: makeIncident(),
        config: makeConfig(),
        runtime: makeRuntime({
          canPrompt: false,
          onTerminate: () => { terminated = true; },
        }),
      });
      assert.equal(terminated, false);
    });

    it("echoes incident in deferred result", async () => {
      const incident = makeIncident();
      const result = await handleIncident({
        incident,
        config: makeConfig(),
        runtime: makeRuntime({ canPrompt: false }),
      });
      assert.strictEqual(result.incident, incident);
    });
  });

  // ── incident sources ─────────────────────────────────────────────────────────

  describe("incident source variations", () => {
    it("handles source=correlation — uses ruleId as display command when no command field", async () => {
      let capturedArg = null;
      await handleIncident({
        incident: {
          source: "correlation",
          level: "CRITICAL",
          reason: "Mass file deletion detected",
          ruleId: "mass-delete",
          // no command field
        },
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async (arg) => { capturedArg = arg; return "approve"; },
        }),
      });
      assert.equal(capturedArg.command, "mass-delete");
    });

    it("handles source=filewatch — falls back to reason when no command or ruleId", async () => {
      let capturedArg = null;
      await handleIncident({
        incident: {
          source: "filewatch",
          level: "HIGH",
          reason: "Secret file modified by agent",
          // no command, no ruleId
        },
        config: makeConfig(),
        runtime: makeRuntime({
          prompt: async (arg) => { capturedArg = arg; return "approve"; },
        }),
      });
      assert.equal(capturedArg.command, "Secret file modified by agent");
    });
  });

  // ── stats edge cases ─────────────────────────────────────────────────────────

  describe("stats object handling", () => {
    it("works without a stats object (no crash)", async () => {
      await assert.doesNotReject(() =>
        handleIncident({
          incident: makeIncident(),
          config: makeConfig(),
          runtime: makeRuntime({ prompt: async () => "approve" }),
          // stats deliberately omitted
        })
      );
    });

    it("accumulates blocked counts across multiple deny calls", async () => {
      const stats = { approved: 0, intercepted: 0, blocked: {} };
      const opts = {
        config: makeConfig(),
        stats,
        runtime: makeRuntime({
          prompt: async () => "deny",
          onTerminate: () => {},
        }),
      };
      await handleIncident({ ...opts, incident: makeIncident({ level: "HIGH" }) });
      await handleIncident({ ...opts, incident: makeIncident({ level: "HIGH" }) });
      await handleIncident({ ...opts, incident: makeIncident({ level: "CRITICAL" }) });
      assert.equal(stats.blocked["HIGH"], 2);
      assert.equal(stats.blocked["CRITICAL"], 1);
    });
  });
});
