/**
 * AgentGuard File Watcher
 *
 * Monitors the working directory for file changes while an agent runs.
 * Catches edits that bypass shell interception (e.g. Claude Code --print mode).
 *
 * Sensitive files trigger an approval prompt before the session continues.
 * All changes are logged to the audit log regardless of risk level.
 */

import chokidar from "chokidar";
import path from "path";
import chalk from "chalk";
import { promptApproval } from "./approval.js";
import { logIntercepted, logApproved, logDenied } from "./logger.js";
import { restoreSnapshot } from "./snapshot.js";

// ─── Sensitive file patterns ─────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /^\.env(\..*)?$/,                         // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|crt|cer)$/i,         // crypto keys / certs
  /^id_(rsa|ecdsa|ed25519)(\.pub)?$/,       // SSH keys
  /^package(-lock)?\.json$/,                // deps manifest
  /^(Dockerfile|docker-compose\.ya?ml)$/i, // container config
  /\.(config\.(js|ts|cjs|mjs))$/,          // build/tool configs
  /\.(db|sqlite|sqlite3)$/,                 // databases
  /^\.github\/workflows\/.+\.ya?ml$/,      // CI/CD
  /^(\.gitconfig|\.npmrc|\.yarnrc)$/,      // tool credentials
];

const SAFE_EXTENSIONS = [
  ".md", ".txt", ".log", ".json.lock",
];

function isSensitive(filePath) {
  const basename = path.basename(filePath);
  const rel = filePath;

  // Never flag safe extensions
  if (SAFE_EXTENSIONS.some(ext => basename.endsWith(ext))) return false;

  return SENSITIVE_PATTERNS.some(re => re.test(basename) || re.test(rel));
}

function riskLevel(filePath) {
  const basename = path.basename(filePath);
  // Highest risk — secrets and credentials
  if (/^\.env(\..*)?$/.test(basename)) return "HIGH";
  if (/\.(pem|key|p12|pfx)$/i.test(basename)) return "CRITICAL";
  if (/^id_(rsa|ecdsa|ed25519)$/.test(basename)) return "CRITICAL";
  if (/^\.github\/workflows/.test(filePath)) return "HIGH";
  if (/^package(-lock)?\.json$/.test(basename)) return "WARN";
  return "WARN";
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

/**
 * Start watching the working directory for file changes.
 *
 * @param {Object} opts
 * @param {string}   opts.cwd        - Directory to watch
 * @param {string}   opts.agent      - Agent name (for logging)
 * @param {string}   [opts.stashRef] - Snapshot ref for rollback on deny
 * @param {Object}   [opts.stats]    - Shared stats object (mutated in place)
 * @returns {{ stop: Function, fileChanges: Array }}
 */
export function startFileWatcher({ cwd, agent, stashRef, stats }) {
  const fileChanges = [];
  let paused = false;
  let pendingApproval = null;

  const watcher = chokidar.watch(cwd, {
    ignored: [
      /node_modules/,
      /\.git\//,
      /\.agentguard/,
      /\.(log)$/,
    ],
    persistent: true,
    ignoreInitial: true,        // only watch NEW changes
    usePolling: false,
    awaitWriteFinish: false,    // report immediately, don't wait
  });

  async function handleChange(event, filePath) {
    if (paused) return;

    const rel = path.relative(cwd, filePath);
    const sensitive = isSensitive(rel);
    const level = sensitive ? riskLevel(rel) : "SAFE";

    fileChanges.push({ event, file: rel, level, time: new Date().toISOString() });

    if (stats) stats.fileChanges = (stats.fileChanges || 0) + 1;

    if (sensitive) {
      paused = true;
      if (stats) stats.intercepted = (stats.intercepted || 0) + 1;

      console.error("");
      console.error(chalk.yellow(`[AgentGuard] 📁 File change detected: ${rel}`));

      logIntercepted({ command: `${event}: ${rel}`, level, reason: "Sensitive file modified by agent", agent });

      const decision = await promptApproval({
        level,
        command: `${event.toUpperCase()}: ${rel}`,
        reason: `Agent modified a sensitive file`,
      });

      if (decision === "approve") {
        if (stats) stats.approved = (stats.approved || 0) + 1;
        logApproved({ command: `${event}: ${rel}`, level, agent });
        console.error(chalk.green(`[AgentGuard] ✓ Change approved: ${rel}`));
        paused = false;
      } else {
        if (stats) stats.blocked = { ...(stats.blocked || {}), [level]: ((stats.blocked || {})[level] || 0) + 1 };
        logDenied({ command: `${event}: ${rel}`, level, agent });
        console.error(chalk.red(`[AgentGuard] ✗ Change denied: ${rel}`));

        if (stashRef) {
          console.error(chalk.yellow("[AgentGuard] Restoring snapshot..."));
          const snap = restoreSnapshot(stashRef);
          console.error(
            snap.restored
              ? chalk.green(`[AgentGuard] ${snap.message}`)
              : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
          );
        }
        process.exit(1);
      }
    } else {
      // Non-sensitive change — log and show quietly
      console.error(chalk.gray(`[AgentGuard] 📝 ${event}: ${rel}`));
    }
  }

  watcher
    .on("add",    (p) => handleChange("created", p))
    .on("change", (p) => handleChange("modified", p))
    .on("unlink", (p) => handleChange("deleted", p));

  return {
    stop: () => watcher.close(),
    fileChanges,
  };
}
