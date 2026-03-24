/**
 * AgentGuard Audit Logger
 *
 * Writes JSON-lines to ~/.agentguard/audit.log.
 * Each entry is a self-contained JSON object on a single line so the log is
 * trivially parseable with `jq` or any streaming parser.
 *
 * Log entry shape:
 * {
 *   ts:        ISO-8601 timestamp
 *   sessionId: short random ID for the current agentguard session
 *   event:     "command_intercepted" | "command_approved" | "command_denied"
 *              | "session_start" | "session_end" | "snapshot_created"
 *   level:     risk level (SAFE / WARN / HIGH / CRITICAL) — omitted for session events
 *   command:   the shell command string — omitted for session events
 *   reason:    rule reason string — omitted when SAFE or for session events
 *   agent:     name of the wrapped agent (e.g. "codex", "claude")
 * }
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// ─── paths ───────────────────────────────────────────────────────────────────

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const LOG_FILE = path.join(AGENTGUARD_DIR, "audit.log");

// ─── session id ──────────────────────────────────────────────────────────────

// One random ID per process — survives for the lifetime of the agentguard run.
export const sessionId = crypto.randomBytes(4).toString("hex");

// ─── internals ───────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(AGENTGUARD_DIR)) {
    fs.mkdirSync(AGENTGUARD_DIR, { recursive: true });
  }
}

/**
 * Append one JSON-lines entry to the audit log (sync, fire-and-forget style).
 *
 * @param {Object} fields - Arbitrary key/value pairs merged into the entry.
 */
export function log(fields) {
  try {
    ensureDir();
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      ...fields,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Logging must never crash the main process.
    process.stderr.write(`[AgentGuard] logger error: ${err.message}\n`);
  }
}

// ─── convenience helpers ─────────────────────────────────────────────────────

export function logSessionStart(agent) {
  log({ event: "session_start", agent });
}

export function logSessionEnd(agent) {
  log({ event: "session_end", agent });
}

export function logSnapshot(stashRef) {
  log({ event: "snapshot_created", stashRef });
}

export function logIntercepted({ command, level, reason, agent }) {
  log({ event: "command_intercepted", command, level, reason, agent });
}

export function logApproved({ command, level, agent }) {
  log({ event: "command_approved", command, level, agent });
}

export function logDenied({ command, level, agent }) {
  log({ event: "command_denied", command, level, agent });
}

export { LOG_FILE, AGENTGUARD_DIR };
