/**
 * AgentGuard notifier.js tests  (plain Node.js, no test runner)
 *
 * Tests:
 *   1. isNotifierConfigured() → false when no credentials
 *   2. isNotifierConfigured() → false when enabled=true but missing token
 *   3. isNotifierConfigured() → true from env vars alone
 *   4. isNotifierConfigured() → true from config object
 *   5. sendTelegramAlert — message body contains expected fields (fetch mocked)
 *   6. sendTelegramAlert — skips silently with no credentials
 */

import assert from "assert";
import { isNotifierConfigured, sendTelegramAlert } from "../src/notifier.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log("\nnotifier.test.js\n");

// 1. No credentials at all → false
test("isNotifierConfigured() → false when no config and no env vars", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      assert.strictEqual(isNotifierConfigured({}), false);
    }
  );
});

// 2. enabled:true but token missing → false
test("isNotifierConfigured() → false when enabled but botToken missing", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      const config = {
        notifications: { telegram: { enabled: true, botToken: "", chatId: "" } },
      };
      assert.strictEqual(isNotifierConfigured(config), false);
    }
  );
});

// 3. env vars only → true
test("isNotifierConfigured() → true from env vars alone", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: "tok123",
      AGENTGUARD_TELEGRAM_CHAT_ID: "chat456",
    },
    () => {
      assert.strictEqual(isNotifierConfigured({}), true);
    }
  );
});

// 4. config object → true
test("isNotifierConfigured() → true from config object", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "tok-from-config",
            chatId: "chat-from-config",
          },
        },
      };
      assert.strictEqual(isNotifierConfigured(config), true);
    }
  );
});

// 5. sendTelegramAlert — check message body via mocked fetch
await testAsync(
  "sendTelegramAlert() sends correct message body",
  async () => {
    let capturedUrl;
    let capturedBody;

    // Temporarily replace globalThis.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };

    try {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "test-token",
            chatId: "test-chat",
          },
        },
      };

      await sendTelegramAlert(
        {
          command: "rm -rf ./src",
          level: "CRITICAL",
          reason: "Recursive or forced file deletion",
          sessionId: "abc12345def",
          agent: "codex",
        },
        config
      );

      assert.ok(capturedUrl, "fetch should have been called");
      assert.ok(
        capturedUrl.includes("test-token"),
        "URL should include bot token"
      );
      assert.strictEqual(capturedBody.chat_id, "test-chat");

      const msg = capturedBody.text;
      assert.ok(msg.includes("AgentGuard Alert"), "message has header");
      assert.ok(msg.includes("codex"), "message has agent name");
      assert.ok(msg.includes("abc12345"), "message has short session id");
      assert.ok(msg.includes("CRITICAL"), "message has risk level");
      assert.ok(msg.includes("rm -rf ./src"), "message has command");
      assert.ok(msg.includes("/approve_abc12345"), "message has approve command");
      assert.ok(msg.includes("/deny_abc12345"), "message has deny command");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// 6. sendTelegramAlert — silently skips when no credentials
await testAsync(
  "sendTelegramAlert() skips silently with no credentials",
  async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true };
    };

    try {
      await withEnv(
        {
          AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
          AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
        },
        async () => {
          await sendTelegramAlert(
            {
              command: "rm -rf .",
              level: "CRITICAL",
              reason: "test",
              sessionId: "abc",
              agent: "codex",
            },
            {}
          );
        }
      );
      assert.strictEqual(fetchCalled, false, "fetch must not be called when no credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
