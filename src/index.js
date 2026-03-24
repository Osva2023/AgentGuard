/**
 * AgentGuard — main public API
 *
 * Re-exports the primary modules so downstream code (tests, integrations)
 * can import everything from a single entry point.
 */

export { classify, requiresApproval } from "./classifier.js";
export { rules, RISK_LEVELS } from "./rules.js";
export { promptApproval } from "./approval.js";
export { createSnapshot, restoreSnapshot } from "./snapshot.js";
export { runInterceptor } from "./interceptor.js";
export {
  log,
  logSessionStart,
  logSessionEnd,
  logSnapshot,
  logIntercepted,
  logApproved,
  logDenied,
  sessionId,
  LOG_FILE,
  AGENTGUARD_DIR,
} from "./logger.js";
