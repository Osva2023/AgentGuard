/**
 * AgentGuard Correlation Rules
 *
 * Multi-event risk patterns: each rule fires when a *combination* of events
 * has occurred within a given time window, rather than on a single event alone.
 *
 * Each rule object:
 *   id          — unique slug used for lookup and logging
 *   description — human-readable summary shown in alerts
 *   level       — "WARN" | "HIGH" | "CRITICAL"
 *   windowMs    — how far back the rule looks (milliseconds)
 *   match(bus)  — function receiving an EventBus; returns true when the rule fires
 *
 * The rule-matching core is pure (no side effects, no logging, no I/O).  The
 * one exception is the git-operation suppression flag (TASK-027): a small,
 * explicitly-marked stateful seam at the bottom of this file that lets the
 * command-interception layers tell the correlator "a git worktree operation
 * just happened" so legitimate, git-driven file deletions don't trip
 * mass-delete.  It is a process-local TTL flag — no I/O.
 */

// ─── Path exclusions ──────────────────────────────────────────────────────────

// TODO: make this configurable via agentguard.config.json when allowlists are implemented
const BUILD_ARTIFACT_PATHS = [
  ".next/",
  ".next/dev/",
  ".next/server/",
  ".next/static/",
  ".next/cache/",
  "dist/",
  "build/",
  "out/",
  "node_modules/.cache/",
  ".turbo/",
  ".cache/",
  "coverage/",
  ".expo/",
];

function isBuildArtifact(filePath) {
  if (!filePath) return false;
  return BUILD_ARTIFACT_PATHS.some((p) => filePath.includes(p));
}

// ─── Git worktree-operation detection (TASK-027) ──────────────────────────────
//
// A `git checkout` / `git switch` between branches (and pull/merge/rebase/reset/
// restore/stash) legitimately deletes files git removes from the working tree.
// Those deletions surface to the file watcher as a burst of unlink events and
// used to trip the mass-delete CRITICAL rule — a false positive, since the
// agent didn't delete anything; git did.
//
// We treat any of these as a "git worktree operation" and suppress mass-delete
// while one is in flight (see isGitOperationActive + hasRecentGitWorktreeOp).

// Match a git invocation followed by a worktree-reshaping subcommand, staying
// inside a single command segment ([^|;&]* never crosses a pipe / && / ;) so
// e.g. `rm -rf x && git status` cannot be mistaken for a checkout.
const GIT_WORKTREE_OP_RE =
  /\bgit\b[^|;&]*\b(checkout|switch|restore|reset|rebase|merge|pull|stash)\b/;

/** How long after a git worktree op we keep suppressing mass-delete. */
const GIT_OP_TTL_MS = 5_000;

/** How far back the bus is scanned for a git worktree command. */
const GIT_OP_LOOKBACK_MS = 10_000;

/**
 * True when `command` is a git operation that legitimately reshapes the
 * working tree (and therefore may delete files).
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitWorktreeOp(command) {
  return GIT_WORKTREE_OP_RE.test(command ?? "");
}

/**
 * Scan the event bus for a recent git worktree command.  Pure — used as the
 * primary signal when the git command was caught by the PTY-output decoder
 * (which pushes process_exec events onto the bus).
 *
 * @param {import("./event-bus.js").EventBus} bus
 * @param {number} [windowMs=GIT_OP_LOOKBACK_MS]
 * @returns {boolean}
 */
export function hasRecentGitWorktreeOp(bus, windowMs = GIT_OP_LOOKBACK_MS) {
  const since = sinceWindow(windowMs);
  return bus
    .query({ type: "process_exec", since })
    .some((e) => isGitWorktreeOp(e.command));
}

// ─── Git-operation suppression flag (stateful seam, TASK-027) ─────────────────
//
// The shell wrapper / node hook detect commands BELOW the agent's UI and route
// them through the shell daemon, which never pushes onto the event bus — so the
// bus scan above can't see a `git checkout` issued by Claude Code or Codex.
// To cover that path, the interception layers call markGitOperation() when they
// see a git worktree command; mass-delete consults isGitOperationActive().
//
// Implemented as a single "suppress until" timestamp (process-local, no I/O).

let _gitOpUntil = 0;

/**
 * Mark that a git worktree operation just occurred.  Suppresses mass-delete
 * for the next `ttlMs` milliseconds.  `now` is injectable for tests.
 *
 * @param {number} [now=Date.now()]
 * @param {number} [ttlMs=GIT_OP_TTL_MS]
 * @returns {void}
 */
export function markGitOperation(now = Date.now(), ttlMs = GIT_OP_TTL_MS) {
  _gitOpUntil = Math.max(_gitOpUntil, now + ttlMs);
}

/**
 * True while the git-operation suppression window is still open.
 *
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function isGitOperationActive(now = Date.now()) {
  return now < _gitOpUntil;
}

/** Clear the suppression flag — test seam so suites don't bleed into each other. */
export function _resetGitActivity() {
  _gitOpUntil = 0;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Return an ISO timestamp exactly `ms` milliseconds in the past.
 * Used inside match() functions to compute the "since" boundary.
 *
 * @param {number} ms
 * @returns {string} ISO 8601 timestamp
 */
function sinceWindow(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CorrelationRule
 * @property {string}   id          - Unique slug (e.g. "env-plus-network")
 * @property {string}   description - Human-readable summary
 * @property {"WARN"|"HIGH"|"CRITICAL"} level
 * @property {number}   windowMs    - Look-back window in milliseconds
 * @property {(bus: import("./event-bus.js").EventBus) => boolean} match
 */

/** @type {CorrelationRule[]} */
export const CORRELATION_RULES = [
  // ── CRITICAL ───────────────────────────────────────────────────────────────

  {
    id: "env-plus-network",
    description: "Secret file modified then network request — possible exfiltration",
    level: "CRITICAL",
    windowMs: 30_000,
    match(bus) {
      const since = sinceWindow(30_000);
      const secretWritten = bus.query({ type: "file_write", subtype: "secret", since }).length > 0;
      const networkSeen   = bus.query({ type: "process_exec", subtype: "network_request", since }).length > 0;
      return secretWritten && networkSeen;
    },
  },

  {
    id: "mass-delete",
    description: "Mass file deletion detected",
    level: "CRITICAL",
    windowMs: 20_000,
    match(bus) {
      // TASK-027: suppress when a git worktree operation (checkout/switch/
      // pull/merge/…) is in flight — those deletions are git's, not the
      // agent's.  Two signals: the process-local flag (set by whichever
      // interception layer saw the git command, including the shell wrapper /
      // node hook, which never push to the bus) and a bus scan (covers git
      // commands caught by the PTY-output decoder).
      if (isGitOperationActive() || hasRecentGitWorktreeOp(bus)) return false;

      const since = sinceWindow(20_000);
      const deletes = bus
        .query({ type: "file_delete", since })
        .filter((e) => !isBuildArtifact(e.file));
      return deletes.length >= 3;
    },
  },

  {
    id: "force-push-after-delete",
    description: "Force git push following file deletion — history rewrite risk",
    level: "CRITICAL",
    windowMs: 60_000,
    match(bus) {
      const since = sinceWindow(60_000);
      const hasDelete    = bus.query({ type: "file_delete", since }).length > 0;
      const hasForcePush = bus
        .query({ type: "process_exec", subtype: "git_operation", since })
        .some((e) => /--force|-f\b/.test(e.command ?? ""));
      return hasDelete && hasForcePush;
    },
  },

  // ── HIGH ───────────────────────────────────────────────────────────────────

  {
    id: "env-overwrite",
    description: "Secret/credential file overwritten",
    level: "HIGH",
    windowMs: 10_000,
    match(bus) {
      const since = sinceWindow(10_000);
      return bus.query({ type: "file_write", subtype: "secret", since }).length > 0;
    },
  },

  {
    id: "shell-pipe-exec",
    description: "Pipe to shell detected — remote code execution risk",
    level: "HIGH",
    windowMs: 10_000,
    match(bus) {
      const since = sinceWindow(10_000);
      return bus.query({ type: "process_exec", subtype: "shell_exec", since }).length > 0;
    },
  },

  // ── WARN ───────────────────────────────────────────────────────────────────

  {
    id: "dependency-change-plus-network",
    description: "Dependency file changed alongside network activity",
    level: "WARN",
    windowMs: 60_000,
    match(bus) {
      const since = sinceWindow(60_000);
      const depChanged  = bus.query({ type: "file_write", subtype: "dependency", since }).length > 0;
      const networkSeen = bus.query({ type: "process_exec", subtype: "network_request", since }).length > 0;
      return depChanged && networkSeen;
    },
  },
];
