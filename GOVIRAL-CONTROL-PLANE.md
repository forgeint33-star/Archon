# GoViral Control Plane

## Release

- Production branch: `goviral/control-plane-v1`
- Stable release: `goviral-control-plane-v1.0.1`
- Application service: `goviral-archon.service`
- Private entrypoint: Tailscale Serve to the backend bound on `127.0.0.1:8180`
- Canonical brain: `/var/lib/goviral-archon/workspaces/goviral-brain`

## Operational model

The Control Plane provides bounded views of BrainOS health, approvals, runtime modules, Agent Bus metadata, goals, incidents, systemd services and audit events. Large governance trees are never recursively scanned during a request.

Operator actions are restricted to the root-owned `goviral-control-action` allowlist. Every action requires an exact confirmation phrase, a valid CSRF value, a Tailnet/local origin, the operator gate, rate-limit clearance and an append-only audit entry.

Protected services cannot be controlled from the UI. The approval executor remains dry-run governed unless its own independent gates permit otherwise.

## Endpoints

- `GET /api/goviral/overview`
- `GET /api/goviral/approvals`
- `GET /api/goviral/runtime`
- `GET /api/goviral/incidents`
- `GET /api/goviral/goals`
- `GET /api/goviral/agents`
- `GET /api/goviral/actions`
- `POST /api/goviral/actions`

## Validation

The governed-action canary is intentionally isolated from production integrations:

```bash
sudo /usr/local/bin/goviral-control-canary-test
```

It starts and stops `goviral-control-canary.service` through the HTTP action API, verifies success audit records and proves that the approval queue was unchanged.

## ClickUp autosync quarantine

`goviral-clickup-autosync.timer` is disabled. Its previous failed state is captured in a redacted root-only diagnostic and cleared. A quarantine record is stored under `.archon/quarantine`. Enabling ClickUp autosync later requires an explicit review of credentials, target workspace and write policy; it must not be enabled merely to remove a dashboard warning.

## Backups and restore drill

A secure backup runs daily through `goviral-archon-backup.timer`. Archives are mode `0600`, include a SQLite online backup, configuration, audit ledger, approval queue, custom source, operations files and a patch relative to upstream. Every archive has a SHA-256 sidecar.

Run a non-destructive restore drill:

```bash
sudo /usr/local/bin/goviral-archon-restore-drill
```

The drill verifies the checksum, SQLite integrity, queue schema, required files and patch applicability in a temporary Git worktree. It never overwrites production.

## Health and local notifications

`goviral-control-healthcheck.timer` runs every 15 minutes. It checks Archon availability, API doctor status, failed GoViral units, private binding, backup freshness and approval pressure. State changes are written to `.archon/goviral-control-alerts.jsonl` and warnings are sent to the system journal with tag `goviral-control-health`.

External Slack, email or webhook delivery is deliberately not configured because no destination or secret policy has been approved.

## Upstream upgrades

Run:

```bash
sudo /usr/local/bin/goviral-archon-upgrade-check
```

The command fetches `origin/dev`, creates an isolated temporary worktree, tests a merge, runs server/web type-checks and builds the UI. Production is not checked out, merged, restarted or modified. Review the JSON report under `.archon/upgrade-checks` before creating a real upgrade branch.

## Security boundary

The production backend must remain bound to loopback and be reached only through Tailscale. The healthcheck treats a public listener on port `8180` as critical. Current operator gating is appropriate for this single-operator Tailnet deployment. Before any public exposure or multi-user access, enable full Archon authentication and implement explicit viewer/operator/admin authorization; do not expose the present operator endpoint directly to the internet.

## Qdrant decision

Qdrant is not required for the Control Plane. Current data is bounded structured metadata, not a semantic corpus. Semantic indexing is deferred until a defined corpus, embedding model, retention policy, access-control model and measurable retrieval requirement exist. See `ops/goviral-control-plane/QDRANT-DECISION.md`.

## UI performance

The production bundle currently emits a Vite chunk-size warning but passes type-check and build. Code splitting remains a non-blocking optimization; it is not a reliability or security defect.

## v2 Endpoints

- `GET /api/goviral/telegram` — Telegram notification status
- `GET /api/goviral/attention` — Needs Attention Today summary
- `POST /api/goviral/attention/ack` — Acknowledge an attention item
- `GET /api/goviral/search` — Enhanced search with filters and pagination
- `GET /api/goviral/filters` — Saved search filters
- `POST /api/goviral/filters` — Save a search filter
- `GET /api/goviral/integrations/clickup` — ClickUp integration status
- `GET /api/goviral/integrations/qdrant` — Qdrant integration status
- `GET /api/goviral/analytics` — Operational analytics rollup
- `GET /api/goviral/analytics/export` — CSV export of analytics
- `GET /api/goviral/recovery` — Disaster recovery status
- `GET /api/goviral/upgrade` — Upstream compatibility check status

## v2 Governed Actions

- `test-telegram` — Send a test Telegram message (admin only, requires configured credentials)

## Telegram Notifications

Configure with `sudo goviral-telegram-configure`. Credentials stored as root-owned 0600 files under `/etc/goviral/credentials/`. The notifier runs every 15 minutes via `goviral-telegram-notifier.timer`. A daily digest runs at 08:00 UTC via `goviral-daily-ops-report.timer`. Both timers are enabled only after credentials are configured. Deduplication and rate limiting prevent notification storms.

## ClickUp Integration

The old `goviral-clickup-autosync.timer` remains quarantined. A new gated integration is available via `sudo goviral-clickup-configure`. The integration progresses through states: not_configured → read_only_verified → dry_run_verified → canary_verified → production_enabled. Production sync is never enabled without explicit operator confirmation.

## Off-Site Backup

Configure with `sudo goviral-offsite-configure`. Requires an S3-compatible endpoint, an age public key for encryption, and a canary upload before enabling. Credentials are root-owned 0600 files. No plaintext credentials are ever backed up.

## Weekly Upstream Compatibility Check

Runs automatically via `goviral-archon-upgrade-check.timer` (Sundays 04:00 UTC). Creates an isolated worktree, merges origin/dev, runs type-checks and builds. Production is never modified. Results are visible in the Control Plane UI.

## Secure Configuration Commands

```bash
sudo goviral-telegram-configure     # Telegram bot credentials
sudo goviral-clickup-configure      # ClickUp API token
sudo goviral-offsite-configure      # Off-site backup S3 + age key
```

## Rollback

To inspect the stable release without changing production:

```bash
git -C /opt/goviral-archon-src show goviral-control-plane-v1.0.1
```

A production rollback must be preceded by a fresh backup and restore drill. Resetting the live branch or database without those checks is prohibited.
