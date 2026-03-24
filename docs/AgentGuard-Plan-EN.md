# AgentGuard — Complete Technical Plan
**Version 1.0 | March 2026**

---

## The Problem

When you run an AI agent like Codex or Claude Code, the agent has full access to your shell. It can:

- `rm -rf src/` without warning you
- Overwrite your `.env` file with incorrect values
- `git reset --hard` and destroy uncommitted work
- `git push --force` to main
- Modify `package.json`, CI/CD files, Dockerfiles
- Execute scripts with elevated permissions

The agent acts in good faith but makes mistakes. And by the time you notice, the damage is done.

---

## The Solution

AgentGuard is a universal shell wrapper that sits between you and any AI coding agent. It:

1. **Intercepts** every command before it executes
2. **Classifies** the risk level in real time
3. **Queues** risky operations for your approval (with a diff preview)
4. **Rolls back** automatically via git if something goes wrong

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│               AI Agent (Codex / Claude)              │
└────────────────────────┬────────────────────────────┘
                         │ shell commands / file ops
                         ▼
┌─────────────────────────────────────────────────────┐
│              AgentGuard Shell Wrapper               │
│   (intercepts ALL commands before execution)        │
└────────┬───────────────┬──────────────┬─────────────┘
         │               │              │
         ▼               ▼              ▼
   [Risk Classifier] [Git Snapshot] [File Watcher]
         │
    ┌────┴─────┐
    │          │
  SAFE      RISKY
    │          │
 Execute   Approval Queue
             │
         ┌───┴────┐
         │        │
      APPROVE   DENY
         │        │
      Execute  Rollback
                  │
            git restore
```

---

## Core Components

### 1. Shell Interceptor
The heart of the system. Instead of letting the agent talk directly to `/bin/zsh`, AgentGuard acts as a proxy:

```
agent → agentguard-shell → [classify] → /bin/zsh (or blocks)
```

The agent is launched with `SHELL=/usr/local/bin/agentguard-shell`. AgentGuard-shell is a PTY wrapper that parses each command before executing it.

**Commands that trigger approval:**
- `rm`, `rmdir`, `unlink` → DELETE
- `git reset --hard` → GIT DESTRUCTIVE
- `git push --force` → GIT FORCE PUSH
- `git clean -fd` → GIT CLEAN
- `chmod 777`, `chown` → PERMISSION CHANGE
- `> file` (truncate) → FILE TRUNCATE
- `curl | bash`, `wget | sh` → REMOTE EXECUTE

**Files that trigger approval on modification:**
- `.env`, `.env.*`
- `*.pem`, `*.key`, `id_rsa`
- `package.json`, `package-lock.json`
- `Dockerfile`, `docker-compose.yml`
- `.github/workflows/**`
- `*.config.js`, `*.config.ts`
- Database files (`*.db`, `*.sqlite`)

---

### 2. Risk Classifier

**Level 1 — Deterministic rules (regex / pattern matching)**
Fast, offline, zero latency. Covers 80% of cases.

```javascript
const rules = [
  { pattern: /^rm\s+-rf?\s+/, level: 'CRITICAL', reason: 'Recursive delete' },
  { pattern: /^git\s+reset\s+--hard/, level: 'HIGH', reason: 'Destroys uncommitted work' },
  { pattern: />\s*\.env/, level: 'HIGH', reason: 'Overwrites env file' },
  { pattern: /^git\s+push.*--force/, level: 'CRITICAL', reason: 'Force push to remote' },
]
```

**Level 2 — Context-aware scoring (later phase)**
- Does the file being deleted have uncommitted changes?
- How many files does this operation affect?
- Is this the first time the agent touches this file?
- Does the repo have CI/CD that could break?

Risk score 0–100 → configurable threshold per user.

---

### 3. Approval Queue + Rollback

**Approval flow in CLI:**

```
⚠️  AgentGuard intercepted high-risk operation:

  Agent:     Codex (session #4821)
  Command:   rm -rf ./src/utils/
  Risk:      CRITICAL — Recursive delete (4 files, 312 lines)
  Files:     formatters.ts, validators.ts, helpers.ts, index.ts

  [A] Approve    [D] Deny    [S] Snapshot + Approve    [?] Full diff
```

**Rollback system:**
```bash
# At the start of each agent session, AgentGuard runs:
git stash -u -m "agentguard-snapshot-{timestamp}"

# If an operation is denied or something breaks:
git stash pop  # or git checkout -- .
```

For repos without git, creates a snapshot in `~/.agentguard/snapshots/`.

---

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| Shell interceptor | **Rust** (v2) / Node.js (v0) | Low latency, syscall access |
| Risk rules engine | Node.js | Fast to iterate |
| CLI / TUI | **Ink** (React for terminal) | Beautiful TUI without boilerplate |
| Web dashboard (v2) | **Next.js + shadcn/ui** | Fast to build |
| Local storage | **SQLite** via Drizzle | No external deps, works offline |
| Notifications | Telegram Bot API | Already integrated |
| Distribution | npm + Homebrew tap | Where devs live |

---

## Roadmap

### 🟢 PHASE 0 — Foundation (Days 1–3)
**Goal: Working proof of concept**

- [ ] GitHub repo `agentguard`
- [ ] Basic shell wrapper in Node.js
- [ ] 20 detection rules (most common cases)
- [ ] CLI approval flow (simple prompt)
- [ ] Automatic git snapshot at session start
- [ ] Test it yourself with Codex on a real project

**Deliverable:** You can run `agentguard codex` instead of `codex` and get approval prompts for risky ops.

---

### 🟡 PHASE 1 — Usable MVP (Weeks 1–2)
**Goal: Something others can install**

- [ ] `npm install -g agentguard` working
- [ ] Config file (`agentguard.config.json`) per project
- [ ] 50+ detection rules
- [ ] TUI with diff preview (Ink)
- [ ] Audit log in SQLite
- [ ] README and basic docs
- [ ] Support for: Codex, Claude Code, aider, Continue

**Deliverable:** Private beta with 5–10 people from the waitlist.

---

### 🟠 PHASE 2 — Traction (Weeks 3–6)
**Goal: Real users, real feedback**

- [ ] Local web dashboard (`agentguard dashboard` → localhost:3000)
  - View session history
  - Approve ops from browser (useful when agent runs in background)
  - Stats: ops blocked, time saved
- [ ] Telegram/Discord notifications for remote approvals
- [ ] Intelligent risk scoring (repo context)
- [ ] MCP (Model Context Protocol) support — AgentGuard as a tool inside the agent
- [ ] Product Hunt + HN "Show HN" launch

---

### 🔵 PHASE 3 — Monetization (Months 2–3)
**Goal: Revenue**

- [ ] **AgentGuard Cloud** — sync rules and audit log across machines
- [ ] **Team plan** — multiple approvers, roles (who can approve what)
- [ ] **Policy templates** by project type (startup, open-source, fintech)
- [ ] **CI/CD integration** — AgentGuard as a GitHub Action
- [ ] Pricing: Free (local, basic) / Pro $9/mo / Team $29/mo

---

## Testing Strategy

### Technical Testing
```
1. Unit tests — each detection rule
   input: "rm -rf ./src" → expected: CRITICAL

2. Integration tests — mock agent session
   Simulate an agent running commands, verify AgentGuard intercepts them

3. Real-world tests — use it yourself
   Run Codex on a test project with intentional bugs,
   verify AgentGuard catches destructive ops

4. Chaos testing — "malicious" agent
   Script that attempts 30 destructive operations,
   AgentGuard must catch 100%
```

### Market Testing (already running via Venture Swarm)
- Live landing page: https://bit.ly/4dFBaBY
- Goal: 100 signups in 7 days
- 50+ signups → clear signal of real interest
- Interview first 10 signups to understand their specific pain point

---

## Competitive Landscape

| Tool | What it does | AgentGuard difference |
|---|---|---|
| Codex `--permission-mode` | Asks permission for some ops | Only works in Codex, not universal |
| Claude Code `--allowedTools` | Restricts which tools the agent uses | Too restrictive, not granular |
| git pre-commit hooks | Catches at commit time | Too late for destructive ops |
| **None** | Cross-agent monitoring with auto-rollback | **That's AgentGuard** |

**Key differentiator:** The only tool that works with ANY agent, has automatic rollback, and shows a diff preview before you approve.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Interceptor adds latency | Rust core, async by default |
| False positives (blocks safe things) | Granular config, "audit only" mode |
| Agent bypasses shell wrapper | Filesystem monitoring as fallback |
| Agents build this themselves | They have a conflict of interest — they won't |

---

## Branding & Domain

- **Primary:** `agentguard.dev`
- **Alternatives:** `guardagent.sh`, `agentfence.dev`, `codeguard.ai`
- **Logo concept:** A shield with a robot/agent icon inside
- **Tagline:** "Guardrails for AI coding agents before they wreck your repo."

---

## Success Metrics

| Metric | Phase 0 | Phase 1 | Phase 2 |
|---|---|---|---|
| GitHub stars | — | 100 | 500+ |
| npm installs/week | — | 50 | 500+ |
| Email signups | 100 (landing) | 200 | 1,000+ |
| Revenue | $0 | $0 | $500+/mo |

---

*AgentGuard — Built in public. Validated by the community.*
*Landing page: https://bit.ly/4dFBaBY*
