/**
 * AgentGuard Interceptor  (Phase 0 — log-based mode)
 *
 * Spawns the requested AI agent as a child process and taps its stdout/stderr
 * in real time.  Every line is scanned for shell-command-like strings; any
 * that match a risk rule are routed through the approval prompt before the
 * session continues.
 *
 * Phase 0 limitation:
 *   This is a "log-based" detection mode.  We parse the agent's textual
 *   output for command patterns rather than intercepting actual syscalls.
 *   True PTY / syscall interception is planned for Phase 1.
 *
 * How it works:
 *   1. agentguard sets process.env.SHELL to a wrapper script (future Phase 1).
 *   2. The child agent is spawned with stdio inherited for stdin, but piped
 *      for stdout/stderr so we can read its output.
 *   3. Each line of output is classified.  SAFE lines are forwarded to the
 *      terminal immediately.  Risky lines pause further output and prompt.
 *   4. On deny, the session exits and the snapshot (if any) can be restored.
 */

import { spawn } from "child_process";
import { classify, requiresApproval } from "./classifier.js";
import { promptApproval } from "./approval.js";
import {
  logIntercepted,
  logApproved,
  logDenied,
  logSessionEnd,
} from "./logger.js";
import { restoreSnapshot } from "./snapshot.js";
import chalk from "chalk";

// ─── command-pattern heuristic ───────────────────────────────────────────────

/**
 * Rough heuristic: does this line look like a shell command being executed?
 * We match common prefixes like "$ ", "% ", "> ", or lines starting with
 * known command names.  This is intentionally broad for Phase 0.
 *
 * @param {string} line
 * @returns {string|null} The extracted command, or null if not a command line.
 */
function extractCommand(line) {
  // Shell prompt prefixes: "$ cmd", "% cmd", "> cmd"
  const promptMatch = line.match(/^[>$%#]\s+(.+)$/);
  if (promptMatch) return promptMatch[1].trim();

  // Lines like "Running: rm -rf ..." or "Executing: git push --force"
  const runningMatch = line.match(/^(?:running|executing|exec|run):\s+(.+)$/i);
  if (runningMatch) return runningMatch[1].trim();

  return null;
}

// ─── core ────────────────────────────────────────────────────────────────────

/**
 * Launch the agent and intercept its output.
 *
 * @param {Object} options
 * @param {string}   options.agent      - Agent binary name (e.g. "codex")
 * @param {string[]} options.agentArgs  - Arguments to pass to the agent
 * @param {string}   options.stashRef   - Snapshot stash ref (may be null)
 */
export async function runInterceptor({ agent, agentArgs, stashRef }) {
  return new Promise((resolve, reject) => {
    const child = spawn(agent, agentArgs, {
      // stdin flows directly from the user's terminal
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    // Buffer for incomplete lines across chunk boundaries
    let stdoutBuf = "";
    let stderrBuf = "";

    // ── line processors ────────────────────────────────────────────────────

    /**
     * Process a complete line from the agent's output stream.
     * Returns a promise so the stream can be paused while prompting.
     */
    async function processLine(line, stream) {
      const cmd = extractCommand(line);

      if (cmd) {
        const result = classify(cmd);

        if (requiresApproval(result)) {
          logIntercepted({ command: cmd, level: result.level, reason: result.reason, agent });

          // Pause data events while we wait for the user
          child.stdout.pause();
          child.stderr.pause();

          const decision = await promptApproval(result);

          if (decision === "approve") {
            logApproved({ command: cmd, level: result.level, agent });
            // Forward the line and resume
            stream.write(line + "\n");
            child.stdout.resume();
            child.stderr.resume();
          } else {
            // deny or quit
            logDenied({ command: cmd, level: result.level, agent });
            console.error(chalk.red("\n[AgentGuard] Operation blocked."));

            if (stashRef) {
              console.error(chalk.yellow("[AgentGuard] Restoring snapshot…"));
              const snap = restoreSnapshot(stashRef);
              console.error(
                snap.restored
                  ? chalk.green(`[AgentGuard] ${snap.message}`)
                  : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
              );
            }

            logSessionEnd(agent);
            child.kill("SIGTERM");
            process.exit(1);
          }
          return;
        }
      }

      // SAFE or non-command line — pass through immediately
      stream.write(line + "\n");
    }

    // ── stdout handler ─────────────────────────────────────────────────────

    child.stdout.on("data", async (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // incomplete trailing line

      for (const line of lines) {
        await processLine(line, process.stdout);
      }
    });

    child.stdout.on("end", () => {
      if (stdoutBuf) process.stdout.write(stdoutBuf);
    });

    // ── stderr handler ─────────────────────────────────────────────────────

    child.stderr.on("data", async (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();

      for (const line of lines) {
        await processLine(line, process.stderr);
      }
    });

    child.stderr.on("end", () => {
      if (stderrBuf) process.stderr.write(stderrBuf);
    });

    // ── exit ───────────────────────────────────────────────────────────────

    child.on("error", (err) => {
      console.error(
        chalk.red(`[AgentGuard] Failed to start agent "${agent}": ${err.message}`)
      );
      reject(err);
    });

    child.on("close", (code) => {
      logSessionEnd(agent);
      resolve(code ?? 0);
    });
  });
}
