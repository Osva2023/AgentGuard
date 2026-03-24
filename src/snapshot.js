/**
 * AgentGuard Snapshot
 *
 * Creates a git stash before the agent session starts so the user can
 * roll back any changes the agent makes.  Silently no-ops when the current
 * directory is not a git repository.
 */

import { execSync, spawnSync } from "child_process";
import { logSnapshot } from "./logger.js";

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

/**
 * Create a snapshot stash with a timestamped message.
 * Includes untracked files (-u) so the full working tree is preserved.
 *
 * @returns {{ created: boolean, stashRef: string|null, message: string }}
 */
export function createSnapshot() {
  if (!isGitRepo()) {
    return {
      created: false,
      stashRef: null,
      message: "Not a git repository — snapshot skipped.",
    };
  }

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
      message: `Snapshot failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      created: false,
      stashRef: null,
      message: `Snapshot failed (git exit ${result.status}): ${result.stderr.trim()}`,
    };
  }

  const stdout = result.stdout.trim();

  // git stash outputs "No local changes to save" when tree is clean
  if (stdout.startsWith("No local changes")) {
    return {
      created: false,
      stashRef: null,
      message: "Working tree clean — no snapshot needed.",
    };
  }

  // Typical output: "Saved working directory and index state On main: agentguard-snapshot-..."
  logSnapshot(stashMsg);

  return {
    created: true,
    stashRef: stashMsg,
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
