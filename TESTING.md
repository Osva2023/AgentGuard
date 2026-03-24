# AgentGuard — Beta Tester Guide

Thanks for testing AgentGuard! This doc covers everything you need:
install, configure Telegram alerts, run the test scenarios, and send feedback.

---

## What is AgentGuard?

A shell wrapper that sits between you and any AI coding agent (Codex, Claude Code,
Cursor, Copilot, aider…). It intercepts dangerous commands **before** they run,
shows you a prompt to approve or deny, and optionally sends you a Telegram alert
so you can respond even when you're away from the terminal.

---

## Installation

**Requirements:** macOS or Linux, Node.js v18+, git

```bash
# 1. Clone the repo (you need to be added as a collaborator first)
git clone https://github.com/morphius101/agentguard.git
cd agentguard

# 2. Run the installer
bash install.sh
```

The installer handles everything: dependencies, native compilation, and global install.

**Verify it worked:**
```bash
agentguard --help
```

---

## Optional: Telegram Alerts

AgentGuard can send you a Telegram message when it intercepts a risky command —
useful when the agent runs in the background or you're away from the terminal.

**Setup (5 minutes):**

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts — you'll get a **bot token**
3. Send any message to your new bot
4. Get your **chat ID**:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
   Look for `"chat":{"id":` in the response.

5. Create the config file:
   ```bash
   mkdir -p ~/.agentguard
   cat > ~/.agentguard/config.json << EOF
   {
     "notifications": {
       "telegram": {
         "enabled": true,
         "botToken": "YOUR_BOT_TOKEN",
         "chatId": "YOUR_CHAT_ID"
       }
     }
   }
   EOF
   ```

6. Test it:
   ```bash
   # Run the test scenario below — a Telegram alert should arrive
   # at the same time as the CLI prompt appears
   ```

---

## Test Scenarios

### Scenario 1 — Basic interception (5 min)
Tests that AgentGuard catches a dangerous command and waits for your decision.

```bash
# Create a test project
mkdir ~/agentguard-test && cd ~/agentguard-test
git init && echo "hello" > app.js && git add . && git commit -m "init"

# Create a fake agent that tries dangerous things
cat > fake-agent.js << 'EOF'
const steps = [
  "Analyzing project...",
  "$ cat app.js",
  "Cleaning up...",
  "$ rm -rf ./node_modules",
  "Pushing changes...",
  "$ git push --force origin main",
  "Done!"
];
for (const line of steps) {
  await new Promise(r => setTimeout(r, 400));
  process.stdout.write(line + "\n");
}
EOF

# Run it through AgentGuard
agentguard node fake-agent.js
```

**What to expect:**
- `cat app.js` passes through silently (SAFE)
- `rm -rf ./node_modules` triggers the approval box:
  ```
  ┌───────────────────────────────────────────────────────┐
  │  🚨 AgentGuard — CRITICAL RISK OPERATION             │
  ├───────────────────────────────────────────────────────┤
  │  Command:  rm -rf ./node_modules                     │
  │  Risk:     CRITICAL                                  │
  │  Reason:   Recursive or forced file deletion         │
  ├───────────────────────────────────────────────────────┤
  │  [A] Approve   [D] Deny   [Q] Quit session           │
  └───────────────────────────────────────────────────────┘
  ```
- Press **D** → command is blocked, session ends
- If Telegram is configured → alert arrives on your phone at the same time

---

### Scenario 2 — Approve a safe op (3 min)
Tests that you can approve a command and the session continues normally.

Same as Scenario 1, but press **A** when the prompt appears.

**What to expect:**
- Command is allowed through
- Session continues
- Summary shows: `1 intercepted, 1 approved`

---

### Scenario 3 — Real agent (10 min)
Test with your actual AI agent. Works with any of these:

| Agent | Command |
|---|---|
| Claude Code | `agentguard claude --permission-mode bypassPermissions --print "your task"` |
| Codex | `agentguard codex` |
| Aider | `agentguard aider` |
| Cursor (terminal) | `agentguard cursor` |
| Any CLI agent | `agentguard <agent-name> [args]` |

**Suggested task to give the agent:**
> "Clean up this project: remove any unused files, clear node_modules, and reset git history to a single commit."

This almost certainly triggers AgentGuard on the dangerous parts.

---

### Scenario 4 — Dashboard (2 min)
After running any scenario, check the local dashboard:

```bash
agentguard dashboard
```

Open http://localhost:7429 in your browser.

**What to expect:** a dark-themed dashboard showing your session history,
commands intercepted, and a timeline of events.

---

## What to Pay Attention To

Please note anything that feels off:

- Did the prompt appear at the right time?
- Was there any lag or weirdness in the terminal after approving/denying?
- Did the session summary look correct?
- Did the Telegram alert arrive? Was the message clear?
- Did anything break or behave unexpectedly?
- Was the install process smooth? What tripped you up?

---

## How to Send Feedback

Options (pick whatever's easiest):
1. **GitHub Issues** — open an issue on the repo with the label `beta-feedback`
2. **Direct message** — message @RapidCuba on Telegram or X
3. **Voice note / video** — sometimes easier than typing — any format works

**Most valuable feedback:**
- Something that blocked you or confused you
- A command that should have been caught but wasn't
- A command that was caught but shouldn't have been (false positive)
- Your overall gut feeling: would you use this day-to-day?

---

## Known Limitations (Phase 0–2)

- **Log-based fallback:** if `node-pty` fails to compile, AgentGuard uses a
  log-based interceptor that reads agent output instead of intercepting at the
  PTY level. It still works but may miss commands the agent runs silently.
- **No cloud sync yet:** sessions are stored locally in `~/.agentguard/audit.log`
- **No npm package yet:** install is manual via `npm link`
- **Tested agents:** Claude Code, Codex. Others should work but are untested.

---

## Uninstall

```bash
cd /path/to/agentguard
npm unlink
```

---

*AgentGuard is in private beta. Please don't share the repo URL or code.*
*Thank you for your time and feedback — it genuinely shapes what gets built next.*
