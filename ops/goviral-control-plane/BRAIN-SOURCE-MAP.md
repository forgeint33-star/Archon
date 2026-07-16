# GoViral Brain Source Map & Drift Semantics

> Control Plane v3 Architecture Audit — 2026-07-16
> Baseline: `goviral-control-plane-v2.0.0` (commit `225ba615`)

## Integration Status Methodology

Integration state must NEVER be inferred solely from files inside the Brain
repository or the Archon `.env` file. The correct determination uses four layers:

| Layer                            | Example sources                                      | What it proves          |
| -------------------------------- | ---------------------------------------------------- | ----------------------- |
| **1. Framework installed**       | Script in `/usr/local/bin/`, systemd units installed | Code exists to run      |
| **2. Runtime configuration**     | Root-owned credential files, state JSON              | Credentials are present |
| **3. Service / timer state**     | `systemctl is-active`, `is-enabled`                  | Service is scheduled    |
| **4. Last successful execution** | `ExecMainStatus=0`, API `last_sent`, delivery logs   | Integration works       |

A credential directory that is root-owned `0700` will NOT be visible to the
Archon server process (runs as `goviral-archon`). The v2 API endpoint
`/api/goviral/telegram` contains a detection bug: it checks `stat()` on
`/etc/goviral/credentials/telegram-bot-token` from the unprivileged server
process, which fails with EACCES, causing `configured: false` even when
credentials are present and the root-owned Python scripts deliver successfully.

The v3 snapshot service must use systemd timer state and last-execution
evidence — never unprivileged `stat()` on root-owned paths.

## 1. Canonical Sources (source of truth — Brain filesystem)

### Agent Registry

| Source            | Path                               | Role                                                        |
| ----------------- | ---------------------------------- | ----------------------------------------------------------- |
| Registry          | `.governance/agents/registry.json` | Defines registered agent identities, lanes, types, keywords |
| Policies          | `.governance/agents/policies.json` | Defines execution permissions per agent                     |
| Agent definitions | `.claude/agents/*.md`              | Full behavioral definitions for Claude                      |
| Personas          | `.claude/personas/*.md`            | Owner orchestrator (leonidas) and operator gateway          |

All agent counts are dynamically discovered at snapshot time. The v3 API
reports each count with its source and timestamp, never hard-coded values.

**Agent reconciliation (live at audit time):**

| Name             | Lane             | Type     | Registry      | Definition          | Policy        | Notes                                                   |
| ---------------- | ---------------- | -------- | ------------- | ------------------- | ------------- | ------------------------------------------------------- |
| iktinos          | engineering      | worker   | ✓             | ✓                   | ✓             |                                                         |
| demosthenes      | marketing        | worker   | ✓             | ✓                   | ✓             |                                                         |
| pheidias         | creative         | worker   | ✓             | ✓                   | ✓             |                                                         |
| omiros           | copywriting      | worker   | ✓             | ✓                   | ✓             |                                                         |
| hephaistos       | 3d_manufacturing | worker   | ✓             | ✓                   | ✓             |                                                         |
| themistoklis     | security         | gate     | ✓             | ✓                   | ✓             |                                                         |
| aristarchos      | quality          | gate     | ✓             | ✓                   | ✓             |                                                         |
| solon            | finance          | gate     | ✓             | ✓                   | ✓             |                                                         |
| herodotos        | (research)       | (worker) | **✗ MISSING** | ✓                   | **✗ MISSING** | **DRIFT**: definition present, not in registry/policies |
| leonidas         | orchestrator     | persona  | N/A           | `.claude/personas/` | N/A           | Owner-only orchestrator persona                         |
| operator-gateway | operator         | persona  | N/A           | `.claude/personas/` | N/A           | Operator persona, not a normal agent                    |

### Skills

| Source              | Path                               | Role                                              |
| ------------------- | ---------------------------------- | ------------------------------------------------- |
| Skill catalog       | `.governance/skills/catalog.json`  | Canonical catalog of named skills with categories |
| Skill registry      | `.governance/skills/registry.json` | Runtime registration metadata                     |
| Category skill dirs | `.claude/skills/{3d,ads,...}/`     | Canonical skill implementations by category       |
| Agent skills        | `.agents/skills/`                  | Agent-specific skills (higgsfield-\*)             |
| Operational skills  | `.claude/skills/goviral-*/`        | GoViral operational/governance skills             |
| Bridge wrappers     | `.claude/skills/gv-*/`             | `gv-*` bridge wrappers routing to catalog skills  |
| GSAP skills         | `.claude/skills/gsap-*/`           | GSAP animation library reference                  |

All skill counts are dynamically discovered. Catalog entries, bridge wrappers,
and operational skills are separate concepts and must be reported distinctly.

### Clients

| Source             | Path                                                 | Role                                    |
| ------------------ | ---------------------------------------------------- | --------------------------------------- |
| Client index       | `.governance/client-context/client-index.json`       | Canonical client list                   |
| Client directories | `clients/`                                           | Filesystem client workspaces            |
| Runtime knowledge  | `.governance/client-knowledge/runtime-index.json`    | Runtime-imported knowledge (gitignored) |
| Project bridge     | `.governance/client-project-bridge/project-map.json` | Client→project mapping                  |

Drift between indexed clients and filesystem directories is detected dynamically.

### Tools & MCP

| Source                   | Path                                                | Role                                                  |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------- |
| Tool activation registry | `.governance/tool-activation-registry/tools/*.json` | Registered tools                                      |
| Tools directory          | `.governance/tools/*.json`                          | Tool configuration                                    |
| MCP config               | `.mcp.json`                                         | MCP server names and env var key names (never values) |

### Governance & Policies

| Source                  | Path                                  | Role                      |
| ----------------------- | ------------------------------------- | ------------------------- |
| Policy files            | `.governance/policies/*.json`         | Governance policies       |
| ClickUp policies        | `.governance/policies/clickup-*.json` | ClickUp-specific policies |
| ClickUp governance dirs | `.governance/clickup-*`               | ClickUp operational state |

## 2. External Integration Status (live at audit time)

### Telegram — CONFIGURED AND OPERATIONAL

| Dimension                | Status                 | Evidence                                                                          |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| Framework installed      | ✓                      | Scripts at `/usr/local/bin/goviral-telegram-notifier`, `goviral-daily-ops-report` |
| Credentials configured   | ✓                      | `/etc/goviral/credentials/` modified today, root:root 0700                        |
| Notifier timer           | ✓ active, enabled      | `systemctl is-active goviral-telegram-notifier.timer`                             |
| Daily digest timer       | ✓ active, enabled      | `systemctl is-active goviral-daily-ops-report.timer`                              |
| Last successful delivery | ✓ 2026-07-16 08:18 UTC | API: `daily_digest.last_sent` with `success: true`                                |
| Notifier last run        | ✓ success              | `ExecMainStatus=0` at 09:05 UTC                                                   |
| API detection bug        | `configured: false`    | v2 API stat()s root-owned files from unprivileged process — EACCES                |

**v3 fix required:** Determine Telegram state from systemd timer state +
`daily-digest-state.json` success evidence, not from unprivileged `stat()`.

### ClickUp — NOT CONFIGURED

| Dimension              | Status                        | Evidence                                                                   |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Framework installed    | ✓                             | Scripts, 10 active timers, 24 governance dirs, 26 policies                 |
| Credentials configured | ✗                             | No `/etc/goviral/credentials/clickup-api-token`, no integration state file |
| Timers                 | Active (monitoring/gate mode) | All 10 ClickUp timers run but operate in no-credential safe mode           |
| v2 source registry     | `enabled: false`              | `.governance/v2-sources/registry.json`                                     |
| API state              | `not_configured`              | Confirmed via `/api/goviral/integrations/clickup`                          |

### Qdrant — RESOURCE DEFERRED

| Dimension       | Status                  | Evidence                                                       |
| --------------- | ----------------------- | -------------------------------------------------------------- |
| Code complete   | ✓ (per ADR)             | `QDRANT-DECISION.md` documents deferral due to RAM constraints |
| Runtime enabled | ✗                       | API confirms `resource_deferred`                               |
| Active fallback | keyword/metadata search | No semantic indexing                                           |

### Off-site Backup — NOT CONFIGURED

| Dimension              | Status   | Evidence                                                      |
| ---------------------- | -------- | ------------------------------------------------------------- |
| Framework installed    | ✓        | `goviral-offsite-backup`, `goviral-offsite-configure` scripts |
| Credentials configured | ✗        | No `/etc/goviral/credentials/offsite-backup.json`             |
| Local backup           | ✓ active | Timer active, last run 03:17 UTC, `Result=success`            |
| Restore drill          | ✓ PASS   | Latest at 2026-07-16 01:23 UTC                                |

### Upstream Compatibility — STALE/DIRTY_WORKTREE

| Dimension     | Status                      | Evidence                                           |
| ------------- | --------------------------- | -------------------------------------------------- |
| Timer         | ✓ active (weekly Sun 04:00) | Scheduled                                          |
| Latest status | `DIRTY_WORKTREE`            | Checked 2026-07-15 21:24 — worktree was not clean  |
| Bug           | Stale status persists       | v2 conflates historical failure with current state |

## 3. Runtime-Only Sources (gitignored)

Per `.governance/.gitignore`:

- `events/*.log`, `events/*.jsonl`, `trace/*.log` — Logs
- `approval/queue.json` — Approval queue (runtime state)
- `deploy-plans/`, `releases/`, `heartbeats/`, `agent-bus/threads/` — Runtime dirs
- `launch-plans/`, `launch-runs/`, `production-unlock/` — Launch state
- `watchdog/`, `operator-audits/`, `workflows/`, `research/` — Operational state

## 4. Identified Drift

| Issue                          | Severity | Detail                                                                                                            |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| **herodotos agent drift**      | HIGH     | Definition at `.claude/agents/herodotos.md` but missing from registry and policies                                |
| **Client naming drift**        | MEDIUM   | `Anna-Rodopoulou` dir vs `Anna Rodopoulou Boutique` in index; `Aithrion` not indexed                              |
| **Telegram API detection bug** | HIGH     | `configured: false` when credentials exist but are root-owned 0700                                                |
| **Agent semantic confusion**   | CRITICAL | `/api/goviral/agents` returns agent-bus runs as `summary.total` — conflates run count with registered agent count |
| **Stale upgrade status**       | HIGH     | `DIRTY_WORKTREE` persists as current status without distinguishing historical from current                        |
| **BRAIN_ROOT inconsistency**   | MEDIUM   | `goviral-control-plane.ts` uses env var; `goviral-phase2/3.ts` hardcode path                                      |
| **Swarm/council dashboards**   | LOW      | Directories exist but no `status.json` — no live status data                                                      |

## 5. Agent Semantic Definitions (v3 — REQUIRED)

| Field                         | Meaning                                            | Source                             |
| ----------------------------- | -------------------------------------------------- | ---------------------------------- |
| `registered_count`            | Agents in registry.json                            | `.governance/agents/registry.json` |
| `discovered_definition_count` | Agent .md files in .claude/agents/                 | Filesystem discovery               |
| `registry_drift_count`        | Definitions without registry entries or vice versa | Computed reconciliation            |
| `worker_count`                | Workers (type=worker)                              | Registry                           |
| `gate_count`                  | Gates (type=gate)                                  | Registry                           |
| `orchestrator_count`          | Personas in .claude/personas/                      | Filesystem discovery               |
| `enabled_count`               | Agents with can_execute=true                       | Policies                           |
| `active_now_count`            | Agent-bus threads currently running                | Runtime agent-bus scan             |
| `runs_24h_count`              | Thread modifications in last 24h                   | Runtime agent-bus scan             |
| `recent_run_count`            | Thread modifications in last 30min                 | Runtime agent-bus scan             |

These are never hard-coded. Every value is computed from its canonical source
at snapshot time and reported with source path and freshness timestamp.

## 6. Privacy Boundaries

**NEVER expose:**

- Credential values (tokens, keys, passwords, chat IDs)
- Environment file contents
- Client knowledge file contents (only metadata/counts/freshness)
- MCP command arguments containing secrets
- Approval queue mutations outside governed actions

**Safe to expose (metadata only):**

- Client names, project names, file counts
- Agent names, lanes, types, skill assignments
- Tool names, activation status, owner agent
- MCP server names and env var key names (never values)
- Credential key names and boolean presence (never values)
- Counts, timestamps, freshness indicators
- Systemd timer state (active/enabled/last-run)

## 7. Refresh Strategy

| Data                    | Refresh Method                      | Staleness Threshold      |
| ----------------------- | ----------------------------------- | ------------------------ |
| Agent registry/policies | Brain snapshot                      | 1 hour                   |
| Skills catalog          | Brain snapshot                      | 1 hour                   |
| Client index            | Brain snapshot                      | 1 hour                   |
| Agent-bus threads       | Direct filesystem read (cached 30s) | 5 minutes                |
| Approval queue          | Direct filesystem read              | Real-time                |
| Integration status      | systemd + state files               | Per request (cached 60s) |
| Systemd units           | systemctl                           | Per request (cached 30s) |

## 8. Backward Compatibility

All 22 existing v1/v2 routes must continue returning compatible response shapes.
New v3 endpoints live under `/api/goviral/brain/*` — no collision.

UI migration: `GoviralOperationsPanels.tsx` "Total" label must be replaced with
distinct "Registered" + "Runs" metrics. All existing panels preserved.

## 9. Archon State Directory Map

```
/var/lib/goviral-archon/
├── .archon/
│   ├── archon.db                    # SQLite database
│   ├── goviral-control-audit.jsonl  # Action audit trail
│   ├── goviral-control-health.json  # Latest health check
│   ├── goviral-control-alerts.jsonl # Health alert transitions
│   ├── incidents-ack.json           # Acknowledged incidents
│   ├── agent-tasks.json             # Agent task state
│   ├── agent-task-audit.jsonl       # Task audit trail
│   ├── clickup-integration.json     # ClickUp state
│   ├── qdrant-integration.json      # Qdrant state
│   ├── offsite-backup.json          # Off-site backup state
│   ├── notifications/               # Telegram dedup & rate state
│   ├── upgrade-checks/              # Upgrade check results
│   ├── restore-drills/              # Restore drill results
│   ├── analytics/                   # Hourly analytics rollups
│   ├── saved-filters/               # Search filter presets
│   └── quarantine/                  # Quarantined service state
├── backups/control-plane/           # Backup archives
│   └── latest.tar.gz → <dated>.tar.gz
└── workspaces/goviral-brain/        # Canonical Brain
    ├── .governance/                 # 180 governance directories
    ├── .claude/                     # Agent/skill definitions
    ├── .agents/                     # Agent-specific skills
    ├── clients/                     # Client workspaces
    └── ...

/etc/goviral/credentials/            # Root-owned 0700
    ├── telegram-bot-token           # Telegram bot token (root only)
    ├── telegram-chat-id             # Telegram chat ID (root only)
    └── (clickup-api-token)          # Not yet configured
    └── (offsite-backup.json)        # Not yet configured
```
