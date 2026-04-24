/**
 * AgentGuard Sensitive File Patterns
 *
 * Shared between the filewatcher (audit-time detection) and the snapshot
 * module (pre-session backup of gitignored secrets that `git stash -u`
 * cannot capture).
 */

import path from "path";

export const SENSITIVE_PATTERNS = [
  /^\.env(\..*)?$/,                         // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|crt|cer)$/i,          // crypto keys / certs
  /^id_(rsa|ecdsa|ed25519)(\.pub)?$/,       // SSH keys
  /^package(-lock)?\.json$/,                // deps manifest
  /^(Dockerfile|docker-compose\.ya?ml)$/i,  // container config
  /\.(config\.(js|ts|cjs|mjs))$/,           // build/tool configs
  /\.(db|sqlite|sqlite3)$/,                 // databases
  /^\.github\/workflows\/.+\.ya?ml$/,       // CI/CD
  /^(\.gitconfig|\.npmrc|\.yarnrc)$/,       // tool credentials
];

export const SAFE_EXTENSIONS = [
  ".md", ".txt", ".log", ".json.lock",
];

export function isSensitive(filePath) {
  const basename = path.basename(filePath);
  const rel = filePath;
  if (SAFE_EXTENSIONS.some(ext => basename.endsWith(ext))) return false;
  return SENSITIVE_PATTERNS.some(re => re.test(basename) || re.test(rel));
}
