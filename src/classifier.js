/**
 * AgentGuard Classifier
 *
 * Evaluates a shell command string against the rule set and returns a
 * classification result.  Rules are tested in declaration order; the first
 * match determines the outcome.  Commands that match no rule are SAFE.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { rules, RISK_LEVELS } from "./rules.js";

/**
 * @typedef {Object} ClassifyResult
 * @property {string} command   - The original command string
 * @property {string} level     - One of SAFE | WARN | HIGH | CRITICAL
 * @property {string|null} reason - Human-readable reason (null when SAFE)
 * @property {RegExp|null} matchedPattern - The rule pattern that fired (null when SAFE)
 */

/**
 * Classify a shell command.
 *
 * @param {string} command - Raw command string (trimmed or untrimmed)
 * @returns {ClassifyResult}
 */
export function classify(command) {
  const trimmed = command.trim();

  for (const rule of rules) {
    if (rule.pattern.test(trimmed)) {
      return {
        command: trimmed,
        level: rule.level,
        reason: rule.reason,
        matchedPattern: rule.pattern,
      };
    }
  }

  return {
    command: trimmed,
    level: RISK_LEVELS.SAFE,
    reason: null,
    matchedPattern: null,
  };
}

/**
 * Returns true if the classification requires human approval.
 *
 * @param {ClassifyResult} result
 * @returns {boolean}
 */
export function requiresApproval(result) {
  return (
    result.level === RISK_LEVELS.WARN ||
    result.level === RISK_LEVELS.HIGH ||
    result.level === RISK_LEVELS.CRITICAL
  );
}

// ─── base scores per risk level ───────────────────────────────────────────────

const BASE_SCORES = {
  [RISK_LEVELS.CRITICAL]: 90,
  [RISK_LEVELS.HIGH]: 70,
  [RISK_LEVELS.WARN]: 40,
  [RISK_LEVELS.SAFE]: 10,
};

/**
 * @typedef {Object} ContextScoreResult
 * @property {string}   level         - Original rule level (SAFE/WARN/HIGH/CRITICAL)
 * @property {string|null} reason     - Original rule reason
 * @property {number}   contextScore  - Composite score 0–100
 * @property {string[]} contextNotes  - Human-readable context factors
 */

/**
 * Classify a command and then adjust the score based on runtime context
 * (git status, CI env, number of affected files, etc.).
 *
 * All checks are synchronous and silently fail-safe so they never block
 * or crash an interceptor that calls this function.
 *
 * @param {string} command
 * @param {string} [cwd]  Working directory (defaults to process.cwd())
 * @returns {ContextScoreResult}
 */
export function scoreWithContext(command, cwd = process.cwd()) {
  const base = classify(command);
  let score = BASE_SCORES[base.level] ?? 10;
  const notes = [];

  function run(cmd) {
    try {
      return execSync(cmd, { cwd, stdio: "pipe", timeout: 3000 })
        .toString()
        .trim();
    } catch {
      return "";
    }
  }

  // ── Is the cwd inside a git repo? ─────────────────────────────────────────
  // If yes, rollback is possible → slightly lower effective risk.
  let inGitRepo = false;
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe", timeout: 2000 });
    inGitRepo = true;
    score -= 5;
  } catch {
    // Not a git repo — no adjustment.
  }

  // ── CI environment? ───────────────────────────────────────────────────────
  if (process.env.CI) {
    score += 30;
    notes.push("Running in CI environment");
  }

  // ── Does the targeted file have uncommitted changes? ──────────────────────
  if (inGitRepo && /\brm\b/.test(command)) {
    const changed = run("git diff --name-only HEAD");
    if (changed) {
      const count = changed.split("\n").filter(Boolean).length;
      score += 20;
      notes.push(
        `${count} uncommitted file${count === 1 ? "" : "s"} would be affected`
      );
    }
  }

  // ── How many files would be deleted? ─────────────────────────────────────
  if (/\brm\b.*(?:-r|-R|--recursive)/.test(command)) {
    const pathsStr = command
      .replace(/^(?:.*\s)?rm\s+/, "")
      .replace(/(?:^|\s)-[rRfFivI]+/g, "")
      .replace(/--(?:recursive|force|interactive\S*)/g, "")
      .trim();

    if (pathsStr) {
      const rawCount = run(
        `find ${pathsStr} -maxdepth 5 2>/dev/null | wc -l`
      );
      const count = parseInt(rawCount, 10);
      if (!isNaN(count) && count > 10) {
        score += 15;
        notes.push(`${count} files would be affected`);
      }
    }
  }

  // ── agentguard.config.json present? ──────────────────────────────────────
  // User is aware of AgentGuard → slightly lower score.
  if (existsSync(`${cwd}/agentguard.config.json`)) {
    score -= 5;
  }

  return {
    level: base.level,
    reason: base.reason,
    contextScore: Math.max(0, Math.min(100, score)),
    contextNotes: notes,
  };
}
