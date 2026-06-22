/**
 * AgentGuard Daemon — ordered shutdown sequence (TASK-029)
 *
 * Extracted from bin/agentguard-daemon.js so the ordering contract is unit-
 * testable without spawning the daemon (the binary runs side-effects at import).
 *
 * Contract — steps run strictly in this order, and a failure in one step never
 * skips the remaining ones (best-effort teardown):
 *   1. (the stop signal has already been received by the caller)
 *   2. terminate active PTY sessions   → terminatePty()
 *   3. stop the file watchers          → stopWatchers()
 *   4. finalize the daemon (pid file, session_end log) → finalize()
 *
 * This module is pure: it only orchestrates the injected step functions.
 */

/**
 * @param {Object} steps
 * @param {() => Promise<{terminated:number, killed:number}>|{terminated:number, killed:number}} steps.terminatePty
 * @param {() => (Promise<void>|void)} steps.stopWatchers
 * @param {() => (Promise<void>|void)} steps.finalize
 * @param {(msg: string) => void} [steps.log]
 * @returns {Promise<{order: string[], pty: {terminated:number, killed:number}}>}
 *   `order` is the sequence of completed steps (for assertions); `pty` is the
 *   terminate result so the caller can report how many sessions were stopped.
 */
export async function shutdownSequence({
  terminatePty,
  stopWatchers,
  finalize,
  log = () => {},
}) {
  const order = [];
  let pty = { terminated: 0, killed: 0 };

  // 2. Terminate active PTY sessions FIRST, so no wrapped agent keeps running
  //    past the daemon it was launched alongside.
  try {
    pty = (await terminatePty()) ?? pty;
  } catch (err) {
    log(`PTY termination error: ${err.message}`);
  }
  order.push("terminate-pty");

  // 3. Stop the file watchers.
  try {
    await stopWatchers();
  } catch (err) {
    log(`watcher stop error: ${err.message}`);
  }
  order.push("stop-watchers");

  // 4. Finalize: remove the pid file and log session end.
  try {
    await finalize();
  } catch (err) {
    log(`finalize error: ${err.message}`);
  }
  order.push("finalize");

  return { order, pty };
}
