# AgentGuard — Current Status & Next Steps
**Date:** March 27, 2026

---

## What Does AgentGuard Do Today?

AgentGuard is a terminal wrapper that sits between the developer and any AI coding agent (Claude Code, Codex, aider). Its job is to monitor what the agent does while it works.

It has two active defense layers:

**Layer 1 — PTY Interceptor (shell commands)**
Monitors the terminal in real time. If the agent tries to run destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, etc.), AgentGuard classifies them by risk level and can require approval before execution.

**Layer 2 — File Watcher (file edits)**
Monitors the filesystem in parallel. Detects any file the agent modifies — even if the agent doesn't use shell commands (as Claude Code does in `--print` mode). If the file is sensitive (`.env`, private keys, CI/CD configs), it alerts the developer.

**Snapshot System**
At the start of each session, AgentGuard automatically runs `git stash` to save the current repo state. If something goes wrong, the developer can roll back instantly.

**Audit Log**
Every session is recorded in `~/.agentguard/audit.log` — commands run, files touched, what was approved and what was blocked.

---

## What Was Tested Today (Mar 27)

### ✅ What Worked
- Global install via `npm install -g .`
- Automatic snapshot on detecting repo changes
- Watcher detected `index.js` edit in real time while Claude worked
- Watcher detected `.env` edit and triggered the approval prompt (HIGH RISK)
- Session summary with command count, file edits, and snapshot status
- Bug fix: summary no longer shows "not a git repo" when working tree is clean

### ⚠️ What the Test Revealed
- In `--print` mode, Claude writes files and finishes in milliseconds — the watcher detects the change but can't pause the agent in time. Snapshot rollback is the correct solution for this case.
- The PTY interceptor captures nothing in `--print` mode — only the watcher works there.

---

## Key Design Decision

> **AgentGuard should not block what the developer explicitly asks for.**
> Its value is in detecting unintended side effects.

| Scenario | AgentGuard intervenes? |
|---|---|
| "Update my .env" → Claude edits .env | ❌ That was the intent |
| "Refactor auth.js" → Claude touches .env as side effect | ✅ Unintended side effect |
| "Clean up the code" → Claude runs `rm -rf utils/` | ✅ Unexpected destructive action |
| "Delete the old tests" → Claude deletes tests | ❌ That was the intent |

This means AgentGuard needs **intent context** — knowing what the developer asked the agent to do, so it can distinguish expected actions from side effects. This is the product's most important differentiator and no tool on the market does it today.

---

## What's Missing

### Technical
- [ ] **Automatic rollback on deny** — when the watcher detects a sensitive file change and the user denies it, AgentGuard should restore the snapshot automatically. The snapshot already exists; the missing piece is wiring deny → restore.
- [ ] **Intent context** — pass the developer's original prompt to AgentGuard so it can compare the agent's action against declared intent. Alert when Claude touches something out of scope.
- [ ] **Diff preview** — before approving or denying, show exactly what changed in the file (like `git diff`). Currently only shows the filename.
- [ ] **Audit-only mode** — run without interrupting, just log. Useful for developers who want to observe what the agent does without blocking anything.
- [ ] **Per-project config** — `agentguard.config.json` defining which files to protect, which risk levels to auto-approve, which directories are off-limits.
- [ ] **Multi-agent support** — tested with Claude Code. Still needs testing with Codex CLI (`@openai/codex`), aider, Continue.
- [ ] **Automated test suite** — a set of "malicious commands" that verifies AgentGuard catches 100% of them.

### Product / UX
- [ ] **Clear install instructions** — `npm install -g agentguard` + 2-minute setup
- [ ] **GIF / demo video** — showing the moment AgentGuard intercepts a `.env` touch. Without this there's nothing to show on GitHub or Product Hunt.
- [ ] **Improved README** — real examples, use cases, and the "why it matters" story

### Outreach / Validation
- [ ] **Publish repo on GitHub** — without announcing, just make it available
- [ ] **5 beta testers** — developers who actively use Claude Code or Codex. Channels: r/LocalLLaMA, r/ClaudeAI, Anthropic Discord, Indie Hackers community
- [ ] **Interview first users** — what agent do they use? Have they lost work to an agent mistake? What would give them more confidence?
- [ ] **Updated landing page** — the current Venture Swarm page is generic. It needs to reflect the real product that exists today.

### Strategic
- [ ] **Product Hunt / HN "Show HN" launch** — once stable with betas. Goal: 100+ GitHub stars, real downloads.
- [ ] **Decide monetization model** — Free local / Pro cloud $9/mo / Team $29/mo. When to activate Stripe?
- [ ] **Domain name** — `agentguard.dev` or another option. Lock this in before public launch.

---

## Logical Order of Next Steps

```
1. Automatic rollback on deny           ← fixes the most critical bug
2. Diff preview before approving        ← makes the product actually useful
3. README + demo GIF                    ← nothing to show without this
4. GitHub public repo                   ← foundation for everything else
5. 5 beta testers                       ← real validation
6. Intent context (MVP)                 ← the key differentiator
7. HN / Product Hunt launch             ← traction
8. Backend + Stripe                     ← monetization
```

---

*AgentGuard — Guardrails for AI coding agents before they wreck your repo.*
