/**
 * AgentGuard Risk Rules
 *
 * Each rule has:
 *   pattern  — RegExp tested against the raw command string
 *   level    — "CRITICAL" | "HIGH" | "WARN"
 *   reason   — Human-readable explanation shown in the approval prompt
 *
 * Rules are evaluated in order; the first match wins.
 */

export const rules = [
  // ─── CRITICAL ────────────────────────────────────────────────────────────

  {
    pattern: /^rm\s+(-[rf]+\s+|--recursive\s+|--force\s+)*[^\s]/,
    level: "CRITICAL",
    reason: "Recursive or forced file deletion",
  },
  {
    pattern: /^git\s+push\s+(.*--force|.*-f)/,
    level: "CRITICAL",
    reason: "Force push to remote (rewrites history)",
  },
  {
    pattern: /^git\s+reset\s+--hard/,
    level: "CRITICAL",
    reason: "Hard reset destroys uncommitted work",
  },
  {
    pattern: /^git\s+clean\s+-[a-z]*f/,
    level: "CRITICAL",
    reason: "Git clean removes untracked files",
  },
  {
    pattern: /\|\s*(ba|z|da|fi)?sh(\s|$)/,
    level: "CRITICAL",
    reason: "Piping to shell (remote code execution risk)",
  },
  {
    pattern: /^(sudo\s+)?dd\s+/,
    level: "CRITICAL",
    reason: "dd can destroy entire disks",
  },
  {
    pattern: /^(sudo\s+)?mkfs/,
    level: "CRITICAL",
    reason: "mkfs formats a filesystem",
  },
  {
    pattern: />\s*\/dev\/(sd[a-z]|nvme|disk)/,
    level: "CRITICAL",
    reason: "Writing to raw disk device",
  },

  // ─── HIGH ─────────────────────────────────────────────────────────────────

  {
    pattern: />\s*\.env(\.|$|\s)/,
    level: "HIGH",
    reason: "Overwrites .env file (credentials at risk)",
  },
  {
    pattern: /^(sudo\s+)?chmod\s+(777|a\+[rwx]+)/,
    level: "HIGH",
    reason: "Dangerously permissive chmod",
  },
  {
    pattern: /^(sudo\s+)?chown\s+-R/,
    level: "HIGH",
    reason: "Recursive ownership change",
  },
  {
    pattern: /^git\s+branch\s+(-D|--delete\s+--force)/,
    level: "HIGH",
    reason: "Force-deletes a git branch",
  },
  {
    pattern: /^git\s+tag\s+-d/,
    level: "HIGH",
    reason: "Deletes a git tag",
  },
  {
    pattern: /^(drop|truncate)\s+table/i,
    level: "HIGH",
    reason: "SQL DROP/TRUNCATE destroys table data",
  },
  {
    pattern: />\s*(package\.json|package-lock\.json)/,
    level: "HIGH",
    reason: "Overwrites package manifest",
  },
  {
    pattern: />\s*Dockerfile/,
    level: "HIGH",
    reason: "Overwrites Dockerfile",
  },
  {
    pattern: />\s*docker-compose\.(yml|yaml)/,
    level: "HIGH",
    reason: "Overwrites docker-compose config",
  },
  {
    pattern: />\s*\.github\/workflows\//,
    level: "HIGH",
    reason: "Overwrites CI/CD workflow",
  },
  {
    pattern: /^(sudo\s+)?systemctl\s+(stop|disable|mask)/,
    level: "HIGH",
    reason: "Stops or disables a system service",
  },
  {
    pattern: /^(sudo\s+)?kill\s+-9/,
    level: "HIGH",
    reason: "Force-kills a process",
  },

  // ─── WARN ─────────────────────────────────────────────────────────────────

  {
    pattern: /^npm\s+(install|i|uninstall|rm|remove)\b/,
    level: "WARN",
    reason: "npm dependency change",
  },
  {
    pattern: /^(pip|pip3)\s+(install|uninstall)\b/,
    level: "WARN",
    reason: "Python dependency change",
  },
  {
    pattern: /^brew\s+(install|uninstall|remove)\b/,
    level: "WARN",
    reason: "Homebrew package change",
  },
  {
    pattern: /^git\s+merge\b/,
    level: "WARN",
    reason: "Git merge (potential conflicts)",
  },
  {
    pattern: /^git\s+rebase\b/,
    level: "WARN",
    reason: "Git rebase (rewrites history)",
  },
  {
    pattern: /^(sudo\s+)?(apt|apt-get|yum|dnf|pacman)\s+(install|remove|purge)/,
    level: "WARN",
    reason: "System package change",
  },
  {
    pattern: />\s*\S+\.config\.(js|ts|json)/,
    level: "WARN",
    reason: "Overwrites config file",
  },
  {
    pattern: />\s*\S+\.pem|>\s*\S+\.key|>\s*id_rsa/,
    level: "WARN",
    reason: "Overwrites cryptographic key file",
  },
];

/** Convenience set for quick level checks */
export const RISK_LEVELS = Object.freeze({
  SAFE: "SAFE",
  WARN: "WARN",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});
