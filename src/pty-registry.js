/**
 * AgentGuard PTY Session Registry (TASK-029)
 *
 * The daemon (file watcher) and interactive PTY sessions (`agentguard <agent>`,
 * driven by pty-interceptor.js) are SEPARATE OS processes — they share no
 * memory.  So "Stop Daemon" from the tray could shut the daemon down while a
 * wrapped agent kept running in its own PTY process, orphaned.
 *
 * This module is the shared disk-based registry that bridges them: each PTY
 * session drops a small `<pid>.json` file under ~/.agentguard/pty-sessions/ on
 * spawn and removes it on exit.  On shutdown the daemon reads the directory and
 * terminates every still-live session (SIGTERM → grace → SIGKILL).
 *
 * Every function takes an injectable `dir` (and the terminate helper takes
 * signal/liveness/sleep seams) so the behaviour is unit-testable without real
 * processes or touching the user's home directory.
 */

import fs from "fs";
import os from "os";
import path from "path";

// Under test the registry lives in the OS temp dir so unit/integration runs
// never write to (or kill processes referenced by) the real home directory.
const IS_TEST =
  process.env.NODE_ENV === "test" || process.env.AGENTGUARD_TEST === "1";

/** Default registry directory.  Overridable per-call via the `dir` argument. */
export const PTY_REGISTRY_DIR = IS_TEST
  ? path.join(os.tmpdir(), "agentguard-test", "pty-sessions")
  : path.join(os.homedir(), ".agentguard", "pty-sessions");

/** Grace period (ms) between SIGTERM and SIGKILL when terminating a session. */
export const PTY_TERMINATE_GRACE_MS = 2000;

// ─── liveness / sleep defaults (injectable seams) ─────────────────────────────

function defaultIsAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours — still alive
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSignal(pid, signal) {
  process.kill(pid, signal);
}

// ─── register / unregister ────────────────────────────────────────────────────

/**
 * Record a live PTY session so the daemon can find and terminate it on stop.
 *
 * @param {Object} opts
 * @param {number}  opts.pid          PID of the PTY-wrapper process (process.pid).
 * @param {string} [opts.cwd]         Workspace the session is running in.
 * @param {string} [opts.agent]       Wrapped agent name (e.g. "claude").
 * @param {string} [opts.sessionId]   AgentGuard session id of the wrapper.
 * @param {string} [opts.dir]         Registry directory (defaults to PTY_REGISTRY_DIR).
 * @param {number} [opts.now]         Timestamp seam for tests.
 * @returns {string|null} The path written, or null on failure (never throws).
 */
export function registerPtySession({
  pid,
  cwd,
  agent,
  sessionId,
  dir = PTY_REGISTRY_DIR,
  now = Date.now(),
}) {
  if (!Number.isFinite(pid)) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${pid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid,
        cwd: cwd ?? null,
        agent: agent ?? null,
        sessionId: sessionId ?? null,
        startedAt: new Date(now).toISOString(),
      })
    );
    return file;
  } catch {
    // Registration is best-effort — it must never break a real agent session.
    return null;
  }
}

/**
 * Remove a PTY session's registry entry (on clean exit).  Never throws.
 *
 * @param {number} pid
 * @param {string} [dir]
 */
export function unregisterPtySession(pid, dir = PTY_REGISTRY_DIR) {
  try {
    fs.unlinkSync(path.join(dir, `${pid}.json`));
  } catch {
    // Already gone (or never written) — fine.
  }
}

/**
 * Read all registered PTY sessions.  Malformed entries are skipped.
 *
 * @param {string} [dir]
 * @returns {Array<{pid:number, cwd:?string, agent:?string, sessionId:?string, startedAt:string}>}
 */
export function listPtySessions(dir = PTY_REGISTRY_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no directory yet → no sessions
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (Number.isFinite(entry.pid)) out.push(entry);
    } catch {
      // Skip unreadable / malformed entries.
    }
  }
  return out;
}

// ─── terminate ────────────────────────────────────────────────────────────────

/**
 * Terminate every live registered PTY session.
 *
 * Sequence (per TASK-029):
 *   1. SIGTERM all live sessions.
 *   2. Wait `graceMs` for clean exit.
 *   3. SIGKILL any survivor.
 *   4. Prune every targeted entry from the registry.
 *
 * Dead entries (stale files for processes that already exited) are pruned, and
 * `selfPid` is never signalled — the daemon must not kill itself here.
 *
 * @param {Object} [opts]
 * @param {string}   [opts.dir]        Registry directory.
 * @param {number}   [opts.graceMs]    SIGTERM→SIGKILL grace window.
 * @param {(pid:number, signal:string)=>void} [opts.signalFn]  Defaults to process.kill.
 * @param {(pid:number)=>boolean}              [opts.isAliveFn] Defaults to a real probe.
 * @param {(ms:number)=>Promise<void>}         [opts.sleepFn]   Defaults to setTimeout.
 * @param {number}   [opts.selfPid]    PID to never signal (defaults to process.pid).
 * @param {(msg:string)=>void} [opts.log]  Receives a one-line summary.
 * @returns {Promise<{terminated:number, killed:number, pids:number[]}>}
 */
export async function terminatePtySessions({
  dir = PTY_REGISTRY_DIR,
  graceMs = PTY_TERMINATE_GRACE_MS,
  signalFn = defaultSignal,
  isAliveFn = defaultIsAlive,
  sleepFn = defaultSleep,
  selfPid = process.pid,
  log = () => {},
} = {}) {
  // Partition into live targets vs stale entries to prune.
  const active = [];
  for (const session of listPtySessions(dir)) {
    if (session.pid === selfPid) continue;
    if (isAliveFn(session.pid)) active.push(session);
    else unregisterPtySession(session.pid, dir); // prune stale file
  }

  if (active.length === 0) {
    return { terminated: 0, killed: 0, pids: [] };
  }

  // 1. SIGTERM every live session.
  for (const session of active) {
    try {
      signalFn(session.pid, "SIGTERM");
    } catch {
      // Process vanished between the liveness check and the signal — fine.
    }
  }

  // 2. Grace period for clean shutdown.
  await sleepFn(graceMs);

  // 3. SIGKILL survivors.
  let killed = 0;
  for (const session of active) {
    if (isAliveFn(session.pid)) {
      try {
        signalFn(session.pid, "SIGKILL");
        killed++;
      } catch {
        // Raced to exit during the grace window — fine.
      }
    }
  }

  // 4. Prune the registry entries we handled.
  for (const session of active) unregisterPtySession(session.pid, dir);

  const n = active.length;
  log(
    `terminated ${n} active PTY session${n === 1 ? "" : "s"}` +
      (killed ? ` (${killed} required SIGKILL after ${graceMs}ms)` : "")
  );

  return { terminated: n, killed, pids: active.map((s) => s.pid) };
}
