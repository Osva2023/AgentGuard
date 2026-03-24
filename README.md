# AgentGuard

AgentGuard is a universal shell wrapper that sits between you and any AI coding agent — Codex, Claude Code, aider, and others — to intercept dangerous shell commands before they execute. Instead of trusting that the agent will only do what you asked, AgentGuard classifies every command it attempts to run and prompts you for approval whenever the risk level is WARN, HIGH, or CRITICAL.

## Install

```bash
npm install -g agentguard
```

## Usage

Prefix any agent command with `agentguard`:

```bash
# Wrap OpenAI Codex
agentguard codex

# Wrap Claude Code with a task
agentguard claude --print "refactor my auth module"

# Wrap aider
agentguard aider --model gpt-4
```

When a risky command is detected, you'll see a prompt like:

```
┌─────────────────────────────────────────────────────┐
│  ⚠️  AgentGuard — HIGH RISK OPERATION               │
├─────────────────────────────────────────────────────┤
│  Command:  rm -rf ./src/utils/                      │
│  Risk:     CRITICAL                                 │
│  Reason:   Recursive or forced file deletion        │
├─────────────────────────────────────────────────────┤
│  [A] Approve   [D] Deny   [Q] Quit session          │
└─────────────────────────────────────────────────────┘
```

## How it works

- **Snapshot** — Before the agent session starts, AgentGuard stashes your working tree with `git stash -u` so you can roll back any changes the agent makes.
- **Intercept** — The agent process is wrapped and its output is monitored in real time. Commands matching any of 30+ risk rules are caught before they can cause damage.
- **Audit log** — Every intercepted command, approval, and denial is written as structured JSON to `~/.agentguard/audit.log` for review.

## Risk levels

| Level    | Examples                                      | Action         |
|----------|-----------------------------------------------|----------------|
| CRITICAL | `rm -rf`, `git push --force`, pipe to shell   | Prompt required |
| HIGH     | `chmod 777`, `DROP TABLE`, overwrite `.env`   | Prompt required |
| WARN     | `npm install`, `git merge`, `brew install`    | Prompt required |
| SAFE     | `ls`, `git status`, `cat`, `npm run build`    | Pass-through   |

## Configuration

A `agentguard.config.json` file at the project root (or `~/.agentguard/config.json` for global config) is coming in a future release. Planned options:

```json
{
  "autoApproveWarn": false,
  "blockCriticalWithoutPrompt": false,
  "restoreSnapshotOnDeny": true,
  "additionalRules": []
}
```

## Phase 2 features

### Web dashboard

Launch the local dashboard (served at `http://localhost:7429`):

```bash
agentguard dashboard
```

The dashboard auto-refreshes every 5 seconds and shows:
- Aggregate stats: sessions, intercepted, blocked, approved
- Session table with agent, start time, duration, and command counts
- Click a session row to expand and inspect every event

### Telegram notifications

Set your bot credentials and AgentGuard will send a Telegram alert whenever a risky command is intercepted — useful when an agent runs in the background or in CI:

```bash
export AGENTGUARD_TELEGRAM_BOT_TOKEN="your-bot-token"
export AGENTGUARD_TELEGRAM_CHAT_ID="your-chat-id"
```

Or set them in `agentguard.config.json`:

```json
{
  "notifications": {
    "telegram": {
      "enabled": true,
      "botToken": "your-bot-token",
      "chatId": "your-chat-id"
    }
  }
}
```

Each alert includes the agent name, session ID, risk level, command, reason, and `/approve_<id>` / `/deny_<id>` reply hints.

### Context-aware risk scoring

When AgentGuard prompts for approval it automatically evaluates runtime context — no configuration needed.  Factors considered:

- **CI environment** (`CI` env var set) → score +30
- **Uncommitted files** that would be deleted → score +20
- **More than 10 files** affected by an `rm -rf` → score +15
- **Inside a git repo** (rollback possible) → score −5
- **`agentguard.config.json` present** (user is aware) → score −5

Context notes are shown inside the approval box when relevant.

## License

MIT
