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

## License

MIT
