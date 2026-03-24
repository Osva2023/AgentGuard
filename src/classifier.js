/**
 * AgentGuard Classifier
 *
 * Evaluates a shell command string against the rule set and returns a
 * classification result.  Rules are tested in declaration order; the first
 * match determines the outcome.  Commands that match no rule are SAFE.
 */

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
