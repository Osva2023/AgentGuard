/**
 * AgentGuard Snapshot
 *
 * Creates a git stash before the agent session starts so the user can
 * roll back any changes the agent makes.  Silently no-ops when the current
 * directory is not a git repository.
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { logSnapshot, AGENTGUARD_DIR, sessionId } from "./logger.js";
import { isSensitive } from "./sensitive.js";

/**
 * Check whether the current working directory is inside a git repository.
 *
 * @returns {boolean}
 */
function isGitRepo() {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// Directories never descended into when scanning for sensitive files.
// Mirrors the ignore list in filewatcher.js.
const IGNORED_DIRS = new Set(["node_modules", ".git", ".agentguard"]);

/**
 * Walk the working tree and return all files matching SENSITIVE_PATTERNS.
 * Catches gitignored files (.env, *.key, *.pem, ...) that `git stash -u`
 * silently skips.
 */
function findSensitiveFiles(root) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && isSensitive(rel)) {
        results.push({ abs, rel });
      }
    }
  };
  walk(root);
  return results;
}

/**
 * Copy every sensitive file under `cwd` to
 * ~/.agentguard/snapshots/{sessionId}/{relative-path}.
 * Returns the backup directory path (or null if nothing was backed up).
 */
function backupSensitiveFiles(cwd) {
  const files = findSensitiveFiles(cwd);
  if (files.length === 0) return { dir: null, count: 0 };

  const backupDir = path.join(AGENTGUARD_DIR, "snapshots", sessionId);
  for (const { abs, rel } of files) {
    const dest = path.join(backupDir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    } catch {
      // Best-effort — a single failed copy shouldn't abort the snapshot.
    }
  }
  return { dir: backupDir, count: files.length };
}

/**
 * Create a snapshot stash with a timestamped message.
 * Includes untracked files (-u) so the full working tree is preserved.
 *
 * Also copies any sensitive files (.env, *.key, *.pem, ...) to a
 * per-session backup directory, since `git stash -u` skips gitignored
 * files and those are the ones most worth protecting.
 *
 * @returns {{ created: boolean, stashRef: string|null, sensitiveBackupDir: string|null, message: string }}
 */
export function createSnapshot() {
  if (!isGitRepo()) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: null,
      message: "Not a git repository — snapshot skipped.",
    };
  }

  const backup = backupSensitiveFiles(process.cwd());

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stashMsg = `agentguard-snapshot-${timestamp}`;

  const result = spawnSync("git", ["stash", "-u", "-m", stashMsg], {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.error) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: `Snapshot failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: `Snapshot failed (git exit ${result.status}): ${result.stderr.trim()}`,
    };
  }

  const stdout = result.stdout.trim();

  // git stash outputs "No local changes to save" when tree is clean
  if (stdout.startsWith("No local changes")) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: "Working tree clean — no snapshot needed.",
    };
  }

  // Typical output: "Saved working directory and index state On main: agentguard-snapshot-..."
  logSnapshot(stashMsg);

  return {
    created: true,
    stashRef: stashMsg,
    sensitiveBackupDir: backup.dir,
    message: `Snapshot created: stash "${stashMsg}"`,
  };
}

/**
 * Restore the most recent agentguard snapshot stash (pop it).
 * Used when the user denies a critical operation and wants to roll back.
 *
 * @param {string} stashRef - The stash message used when the snapshot was created.
 * @returns {{ restored: boolean, message: string }}
 */
export function restoreSnapshot(stashRef) {
  if (!isGitRepo()) {
    return { restored: false, message: "Not a git repository." };
  }

  // Find the stash index that matches our ref message
  const listResult = spawnSync("git", ["stash", "list"], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (listResult.status !== 0 || listResult.error) {
    return { restored: false, message: "Could not list stashes." };
  }

  const lines = listResult.stdout.trim().split("\n");
  const matchLine = lines.find((l) => l.includes(stashRef));

  if (!matchLine) {
    return {
      restored: false,
      message: `Snapshot stash not found for ref: ${stashRef}`,
    };
  }

  // Extract stash index from "stash@{N}: ..."
  const match = matchLine.match(/stash@\{(\d+)\}/);
  if (!match) {
    return { restored: false, message: "Could not parse stash index." };
  }

  const stashIndex = `stash@{${match[1]}}`;
  const popResult = spawnSync("git", ["stash", "pop", stashIndex], {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (popResult.status !== 0 || popResult.error) {
    return {
      restored: false,
      message: `Stash pop failed: ${(popResult.stderr || popResult.error?.message || "").trim()}`,
    };
  }

  return {
    restored: true,
    message: `Snapshot restored from stash "${stashRef}".`,
  };
}
