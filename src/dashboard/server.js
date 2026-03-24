/**
 * AgentGuard Dashboard Server  (Phase 2)
 *
 * Serves a local web dashboard at http://localhost:7429 that reads the
 * JSON-lines audit log and exposes it via a simple REST API consumed by
 * the single-page index.html.
 *
 * Start with:  agentguard dashboard
 */

import express from "express";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const DASHBOARD_PORT = 7429;

// ─── audit log reader ─────────────────────────────────────────────────────────

function readAuditLog() {
  const logPath = join(homedir(), ".agentguard", "audit.log");
  if (!existsSync(logPath)) return [];

  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─── session grouping ─────────────────────────────────────────────────────────

function groupBySessions(events) {
  const sessionMap = {};

  for (const event of events) {
    const id = event.sessionId;
    if (!id) continue;

    if (!sessionMap[id]) {
      sessionMap[id] = {
        sessionId: id,
        agent: event.agent || "unknown",
        startTime: null,
        endTime: null,
        intercepted: 0,
        blocked: 0,
        approved: 0,
        events: [],
      };
    }

    const s = sessionMap[id];
    s.events.push(event);

    if (event.event === "session_start") {
      s.startTime = event.ts;
      if (event.agent) s.agent = event.agent;
    }
    if (event.event === "session_end") s.endTime = event.ts;
    if (event.event === "command_intercepted") s.intercepted++;
    if (event.event === "command_denied") s.blocked++;
    if (event.event === "command_approved") s.approved++;
  }

  return Object.values(sessionMap).sort(
    (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
  );
}

// ─── API routes ───────────────────────────────────────────────────────────────

function buildRouter() {
  const router = express.Router();

  // Last 100 events (any kind)
  router.get("/events", (_req, res) => {
    const events = readAuditLog();
    res.json(events.slice(-100));
  });

  // All sessions (without event arrays, for the table view)
  router.get("/sessions", (_req, res) => {
    const events = readAuditLog();
    const sessions = groupBySessions(events);
    res.json(sessions.map(({ events: _e, ...s }) => s));
  });

  // Single session with full event list
  router.get("/sessions/:id", (req, res) => {
    const events = readAuditLog();
    const sessions = groupBySessions(events);
    const session = sessions.find((s) => s.sessionId === req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  });

  // Aggregate stats
  router.get("/stats", (_req, res) => {
    const events = readAuditLog();
    const sessions = groupBySessions(events);
    res.json({
      totalSessions: sessions.length,
      totalIntercepted: sessions.reduce((n, s) => n + s.intercepted, 0),
      totalBlocked: sessions.reduce((n, s) => n + s.blocked, 0),
      totalApproved: sessions.reduce((n, s) => n + s.approved, 0),
    });
  });

  return router;
}

// ─── server entry point ───────────────────────────────────────────────────────

/**
 * Start the dashboard HTTP server.  Never resolves — runs until the process
 * is killed (Ctrl-C).
 */
export async function startDashboard() {
  const app = express();

  // Serve static assets (index.html, etc.)
  app.use(express.static(join(__dirname, "public")));

  // JSON API
  app.use("/api", buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(DASHBOARD_PORT, "127.0.0.1", () => {
      console.log(
        `\n  AgentGuard Dashboard  →  http://localhost:${DASHBOARD_PORT}\n`
      );
      console.log("  Press Ctrl-C to stop.\n");
    });
    server.on("error", reject);
  });

  // Keep the process alive
  await new Promise(() => {});
}
