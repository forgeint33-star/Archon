# Incident Report: Leaf Workflow Concurrency Overload

**Date:** 2026-07-16
**Severity:** P1 (production degradation)
**Duration:** ~45 minutes (detection to resolution)
**Status:** Resolved (hotfix applied; permanent fix in repo)

## Summary

Overlapping systemd timers caused multiple parallel instances of
`goviral-prompt-command-center` and `goviral-brain-auto-workflow` to run
simultaneously, exhausting CPU and degrading all system services.

## Timeline

| Time (UTC) | Event                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| ~16:00     | CPU steal observed at extremely high levels                              |
| ~16:10     | CrowdSec timed out; firewall bouncer became unresponsive                 |
| ~16:15     | systemd overloaded; boot recovery impaired                               |
| ~16:25     | Root cause identified: 3x prompt-command-center + 4x brain-auto-workflow |
| ~16:27     | Production hotfix applied: non-blocking flock guards                     |
| ~16:30     | Both concurrency canaries passed                                         |
| ~16:35     | CPU steal dropped to 1-3%; all services recovered                        |
| ~16:40     | systemctl --failed = 0; Archon health = ok                               |

## Root Cause

Four systemd timer-driven workflows had overlapping schedules:

| Workflow                        | Timer Interval | Role                          |
| ------------------------------- | -------------- | ----------------------------- |
| `goviral-unified-autopilot`     | every 1 min    | Top-level orchestrator        |
| `goviral-nl-autopilot-router`   | every 2 min    | NL routing orchestrator       |
| `goviral-prompt-command-center` | every 3 min    | Leaf: prompt queue processing |
| `goviral-brain-auto-workflow`   | every 5 min    | Leaf: PRD/task pipeline       |

The two higher-level orchestrators (`unified-autopilot`, `nl-autopilot-router`)
**directly invoked** the same leaf workflows that also had their own independent
timers. With no concurrency guard, this produced:

- 3 simultaneous `goviral-prompt-command-center` processes
- 4 simultaneous `goviral-brain-auto-workflow` processes

All 7 processes competed for CPU, causing steal to spike, which cascaded to
CrowdSec timeouts and systemd instability.

### Contributing Factors

1. **No flock or lockfile** — leaf workflows had no concurrency protection
2. **Boot stampede** — all 4 timers used `OnBootSec=2min` or `OnBootSec=3min`,
   causing near-simultaneous initial runs after boot
3. **No RuntimeMaxSec** — runaway processes had no systemd kill deadline
4. **No CPU/IO priority** — batch workflows competed at normal priority with
   interactive services (CrowdSec, Archon, SSH)

## Production Hotfix

Non-blocking `flock` wrappers installed at:

- `/usr/local/bin/goviral-prompt-command-center` (renamed original to `.impl.*`)
- `/usr/local/bin/goviral-brain-auto-workflow` (renamed original to `.impl.*`)

Guard behavior:

- `run-all --write` → acquire `/run/lock/<name>.lock` non-blocking
- Lock held → exit 0, print `overlap_skipped=true` + `workflow=<name>`
- Lock free → exec implementation, propagate exit code
- Other subcommands → exec implementation directly (no lock)

Verified:

- Both concurrency canaries passed
- Approval queue unchanged
- CPU steal 1-3%
- All services active; zero failed units

## Permanent Fix (in repository)

Located at `ops/goviral-control-plane/`:

| File                                    | Purpose                             |
| --------------------------------------- | ----------------------------------- |
| `lib-concurrency-guard.sh`              | Shared guard library with metrics   |
| `goviral-prompt-command-center-guard`   | Wrapper for prompt-command-center   |
| `goviral-brain-auto-workflow-guard`     | Wrapper for brain-auto-workflow     |
| `goviral-prompt-command-center.service` | Hardened systemd service unit       |
| `goviral-prompt-command-center.timer`   | Staggered timer (OnBootSec=3m30s)   |
| `goviral-brain-auto-workflow.service`   | Hardened systemd service unit       |
| `goviral-brain-auto-workflow.timer`     | Staggered timer (OnBootSec=4m)      |
| `deploy-concurrency-fix.sh`             | Idempotent deployment script        |
| `test-concurrency-guard.sh`             | Focused concurrency tests (8 cases) |

### Systemd Hardening Applied

- `RuntimeMaxSec`: 600s (prompt-command-center), 900s (brain-auto-workflow)
- `TimeoutStartSec`: 120s
- `Nice=10` + `IOSchedulingClass=idle` + `IOSchedulingPriority=7`
- Staggered `OnBootSec`: 3m30s / 4m (prevents simultaneous boot fan-out)
- `After=network-online.target` ordering

### Metrics/Audit

JSONL metrics emitted to `/var/lib/goviral-archon/.archon/concurrency-metrics/<workflow>.jsonl`:

```json
{"ts":"...","workflow":"...","status":"completed|overlap_skipped|failed","started_at":"...","duration_s":N,"detail":""}
```

Fields: `started`, `completed`, `failed`, `overlap_skipped`, `duration_s`.

## Rollback Procedure

```bash
# Rollback the permanent fix to pre-fix state
sudo bash /opt/goviral-archon-src/ops/goviral-control-plane/deploy-concurrency-fix.sh --rollback

# Or manually restore the production hotfix:
# The .impl.* files are preserved and the hotfix wrappers are backed up
# in /var/lib/goviral-archon/backups/concurrency-fix/
```

## Prevention

1. All leaf workflows with mutating `run-all --write` paths must use the
   shared `lib-concurrency-guard.sh` library
2. Systemd timer `OnBootSec` values must be staggered (no two leaf workflows
   start at the same offset)
3. All batch services must set `RuntimeMaxSec`, `Nice`, and `IOSchedulingClass`
4. The `deploy-concurrency-fix.sh` is idempotent — re-run it after any
   workflow addition to verify guards are in place
