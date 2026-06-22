/**
 * AgentGuard — syncToServer retry / error-classification tests (TASK-028)
 *
 * Run with:
 *   node --test test/team-sync.test.js
 *
 * syncToServer() forwards audit events to the central team server. These tests
 * verify the TASK-028 hardening: one automatic retry on transient failures, a
 * single (never doubled) stderr line on final failure, error classification
 * (timeout / network / auth / server), and the 8s budget. Driven through the
 * injectable fetchFn / sleepFn seams — no real network, no real delay.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  syncToServer,
  SYNC_TIMEOUT_MS,
  SYNC_RETRY_DELAY_MS,
} from "../src/logger.js";

// ─── fakes ────────────────────────────────────────────────────────────────────

const CONFIG = { team: { serverUrl: "https://x.up.railway.app", token: "tok-123" } };

function abortError() {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
function networkError() {
  return new TypeError("fetch failed");
}
function res(status) {
  return { ok: status >= 200 && status < 300, status };
}

/** fetch fake: behaviors[i] is consumed per call (Error → throw, object → return). */
function scriptedFetch(...behaviors) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const b = behaviors[Math.min(calls.length - 1, behaviors.length - 1)];
    if (b instanceof Error) throw b;
    return b;
  };
  fn.calls = calls;
  return fn;
}

/** sleep fake: records requested delays, resolves immediately. */
function fakeSleep() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

/** Capture process.stderr.write output while `run` (async) executes. */
async function withStderr(run) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { await run(); } finally { process.stderr.write = orig; }
  return lines;
}

const EVENT = { event: "command_intercepted", level: "HIGH", file: "src/x.js" };

// ─── constants ────────────────────────────────────────────────────────────────

describe("sync constants", () => {
  it("timeout is raised to 8s and retry delay is 1s", () => {
    assert.equal(SYNC_TIMEOUT_MS, 8000);
    assert.equal(SYNC_RETRY_DELAY_MS, 1000);
  });
});

// ─── no-op / config gating ─────────────────────────────────────────────────────

describe("syncToServer — config gating", () => {
  it("is a no-op (no fetch) when team is not configured", async () => {
    const fetchFn = scriptedFetch(res(200));
    const out = syncToServer(EVENT, { team: undefined }, { fetchFn });
    assert.equal(out, undefined);
    assert.equal(fetchFn.calls.length, 0);
  });

  it("is a no-op when token is missing", async () => {
    const fetchFn = scriptedFetch(res(200));
    syncToServer(EVENT, { team: { serverUrl: "https://x" } }, { fetchFn });
    assert.equal(fetchFn.calls.length, 0);
  });

  it("is a no-op when the event is null", async () => {
    const fetchFn = scriptedFetch(res(200));
    syncToServer(null, CONFIG, { fetchFn });
    assert.equal(fetchFn.calls.length, 0);
  });
});

// ─── happy path ────────────────────────────────────────────────────────────────

describe("syncToServer — success", () => {
  it("POSTs once to /api/events, tags machine, no retry, no stderr", async () => {
    const fetchFn = scriptedFetch(res(200));
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(sleepFn.delays.length, 0);
    assert.equal(lines.length, 0);

    const { url, opts } = fetchFn.calls[0];
    assert.equal(url, "https://x.up.railway.app/api/events");
    assert.equal(opts.headers.Authorization, "Bearer tok-123");
    const body = JSON.parse(opts.body);
    assert.equal(body.event, "command_intercepted");
    assert.ok(body.machine, "body should be tagged with machine hostname");
  });

  it("strips trailing slashes from serverUrl", async () => {
    const fetchFn = scriptedFetch(res(200));
    await syncToServer(EVENT, { team: { serverUrl: "https://x.up.railway.app///", token: "t" } }, { fetchFn });
    assert.equal(fetchFn.calls[0].url, "https://x.up.railway.app/api/events");
  });
});

// ─── retry behavior ────────────────────────────────────────────────────────────

describe("syncToServer — retry on transient failure", () => {
  it("retries once after a timeout and stays silent when the retry succeeds", async () => {
    const fetchFn = scriptedFetch(abortError(), res(200));
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 2, "should attempt twice");
    assert.deepEqual(sleepFn.delays, [1000], "should wait 1s before retry");
    assert.equal(lines.length, 0, "recovered → no stderr");
  });

  it("retries once after a network error too", async () => {
    const fetchFn = scriptedFetch(networkError(), res(200));
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 2);
    assert.equal(lines.length, 0);
  });

  it("honors a custom retryDelayMs", async () => {
    const fetchFn = scriptedFetch(abortError(), res(200));
    const sleepFn = fakeSleep();
    await syncToServer(EVENT, CONFIG, { fetchFn, sleepFn, retryDelayMs: 50 });
    assert.deepEqual(sleepFn.delays, [50]);
  });
});

// ─── single message on final failure ───────────────────────────────────────────

describe("syncToServer — single stderr line on final failure", () => {
  it("logs exactly one line (not two) when both attempts time out", async () => {
    const fetchFn = scriptedFetch(abortError(), abortError());
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 2);
    assert.equal(lines.length, 1, "must be a single message, never two consecutive");
    assert.match(lines[0], /\(timeout\)/);
  });

  it("classifies a network failure as (network)", async () => {
    const fetchFn = scriptedFetch(networkError(), networkError());
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(network\)/);
  });
});

// ─── non-retriable failures ────────────────────────────────────────────────────

describe("syncToServer — auth / server errors are not retried", () => {
  it("does NOT retry on 401 and reports (auth)", async () => {
    const fetchFn = scriptedFetch(res(401), res(200));
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 1, "auth failure must not retry");
    assert.equal(sleepFn.delays.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(auth\)/);
  });

  it("does NOT retry on 403", async () => {
    const fetchFn = scriptedFetch(res(403));
    const lines = await withStderr(() => syncToServer(EVENT, CONFIG, { fetchFn }));
    assert.equal(fetchFn.calls.length, 1);
    assert.match(lines[0], /\(auth\)/);
  });

  it("reports (server) for a 500 and does not retry", async () => {
    const fetchFn = scriptedFetch(res(500), res(200));
    const sleepFn = fakeSleep();
    const lines = await withStderr(() =>
      syncToServer(EVENT, CONFIG, { fetchFn, sleepFn })
    );
    assert.equal(fetchFn.calls.length, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\(server\)/);
  });
});
