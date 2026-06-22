/**
 * AgentGuard — PTY startup-notice gating tests (TASK-024)
 *
 * Run with:
 *   node --test test/pty-startup-notice.test.js
 *
 * The "shell wrapper not found … falls back to PTY output scanning only"
 * warning used to print on every PTY session start, interrupting normal use.
 * planWrapperNotice() now keeps it quiet by default: the degraded mode is still
 * detected and recorded to the audit log, but the stderr warning only shows
 * with --verbose / --debug.  These tests pin that gating.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planWrapperNotice } from "../src/pty-interceptor.js";

describe("planWrapperNotice — wrapper present", () => {
  it("emits nothing when the wrapper resolved (no degradation)", () => {
    const notice = planWrapperNotice({ wrapperPath: "/path/to/agentguard-shell", verbose: false });
    assert.equal(notice.degraded, false);
    assert.equal(notice.logToAudit, false);
    assert.equal(notice.showOnStderr, false);
  });

  it("stays silent even under verbose when the wrapper is present", () => {
    const notice = planWrapperNotice({ wrapperPath: "/path/to/agentguard-shell", verbose: true });
    assert.equal(notice.degraded, false);
    assert.equal(notice.showOnStderr, false);
  });
});

describe("planWrapperNotice — wrapper missing", () => {
  it("is QUIET on stderr by default but still records the degraded mode", () => {
    const notice = planWrapperNotice({ wrapperPath: null, verbose: false });
    assert.equal(notice.degraded, true, "pty-output-only fallback is still recognized");
    assert.equal(notice.logToAudit, true, "degraded mode is recorded to the audit log");
    assert.equal(notice.showOnStderr, false, "no warning on stderr during normal use");
  });

  it("shows the warning on stderr only when verbose/debug is enabled", () => {
    const notice = planWrapperNotice({ wrapperPath: null, verbose: true });
    assert.equal(notice.degraded, true);
    assert.equal(notice.logToAudit, true);
    assert.equal(notice.showOnStderr, true);
  });

  it("defaults verbose to false (quiet) when omitted", () => {
    const notice = planWrapperNotice({ wrapperPath: null });
    assert.equal(notice.showOnStderr, false);
  });
});
