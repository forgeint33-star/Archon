# PRD — GoViral Control Plane frontend contract hotfix

- **Status:** approved by owner, scoped, frontend-only
- **Date:** 2026-07-19
- **Surface:** `packages/web/src/experiments/console/` (Control Plane console)
- **Change class:** defect repair. No backend, systemd, worker, database, integration or
  permission change.

## 1. Owner approval (recorded verbatim in scope)

The repository owner explicitly authorized a narrowly scoped repair of the existing GoViral
Control Plane frontend at `/opt/goviral-archon-src`, covering: this governed PRD, a
frontend-consumer-only fix, schema/contract + component + browser regression tests, building
Archon as the `goviral-archon` service user (never root), verification against the live
read-only endpoints, a focused commit, pushing **only** to the owned remote `fork` and its
governed target (never `coleam00/archon`), deploying the rebuilt frontend, and restarting
`goviral-archon.service` only if genuinely required with rollback armed and a 60-second
health/PID/restart stability check.

Explicitly excluded by the owner: backend permission expansion, systemd mutation, changes to
runtime workers, autoscaler, databases, quarantine, Telegram, Qdrant, ClickUp or integrations,
and any external write or paid action.

## 2. Problem

`GoviralControlPlanePage.tsx` throws `Cannot read properties of undefined (reading 'pending')`
in the live console.

Root cause is **not** a missing optional-chaining guard. The frontend contract layer
(`skills/goviral.ts`) describes response shapes the backend **never emitted**. The declared
types were written against an intended v3.1 spec; the implemented endpoints return different
shapes. Nothing validates the payloads at any layer — the backend routes are hand-rolled
`c.json()` with no Zod schema, and `requestJson<T>` casts the body with `as Promise<T>` and no
runtime check. A shape mismatch therefore surfaces only as an undefined-property throw deep
inside render.

Verified live against `http://127.0.0.1:8180` (all HTTP 200, real data):

| Endpoint                 | Frontend expected                                               | Backend actually returns                                                                                                    | Consequence                                                                                                     |
| ------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/approvals/analysis`    | `counts{pending,…}`, `duplicate_groups`, `items`                | `total_pending`, `groups`, `classifications`, `validation_errors`, `malformed_count`, `duplicate_group_count`               | **`counts` undefined → the reported live crash**; `items`/`duplicate_groups` also throw                         |
| `/canary/status`         | flat `status`, `task_id`, `cancelled_at`, `result_summary`      | nested `canary{id,status,started_at,completed_at,error}`                                                                    | `status` undefined → `statusTone(undefined).toLowerCase()` **throws**                                           |
| `/agents/reconciliation` | `drift_items`, `proposals`, `summary.total_drift`               | `drift`, `reconciliation_proposal`, `drift_count`, `resolved_count`                                                         | `drift_items.length` **throws**                                                                                 |
| `/services/semantic`     | `aggregates{idle,total}`                                        | `aggregates{running,healthy_idle,scheduled,disabled,degraded,failed,unknown}` + `summary{total,healthy,attention,disabled}` | Services metric renders `undefined/undefined`; `healthy_idle`/`degraded`/`disabled` states have no tone mapping |
| `/access`                | `access_mode_description`, `rbac_role`                          | `rbac{current_role,…}`, `bind_address`, `port`; no description field                                                        | Blank fields                                                                                                    |
| `/integrations`          | `telegram.state`, `last_delivery`, `last_check`; `qdrant.state` | `enabled`, `reachable`, `last_delivery_at`, `last_error_summary`, `notifier_timer_active`, …; no `state`                    | Status pills render `undefined`                                                                                 |
| `/overview`              | `brain?.snapshot_freshness?` optional                           | always present, plus `health`, `cache`, `drift_count`; `snapshot_freshness` carries `source_updated_at`, `producer`         | Freshness evidence partly discarded                                                                             |

Secondary defects in the same file:

1. **Misleading defaults.** `overview?.doctor.status ?? 'UNKNOWN'` and
   `semanticAgg ? … : 0` render _not yet loaded_ and _could not be read_ as a measured
   `UNKNOWN` / `0` / `0/0`. Loading, unavailable, stale, partial and error are not distinguished.
2. **Literal escape sequences in JSX text.** `…`, `—`, `·` appearing as JSX
   _children_ are not escape sequences — they render literally on screen
   (lines 551, 994, 1115, 1162). The same sequences inside JS string/template literals are
   correct and are left alone.
3. **`/runtime` truth loss.** `GoviralCommandCenter` declares `RuntimeData { services }` and
   discards the endpoint's `available: boolean` and `error: string` fields. Live, that endpoint
   is genuinely degraded (`available: false`, `error: "systemd unit details unavailable"`,
   `services: []` while `/services/semantic` reports 40). The console currently renders that
   degraded state as an ordinary empty list — a falsified availability claim.
4. **Same crash pattern in siblings** rendered by the same page:
   `incidents?.doctor.status`, `goals?.summary.documents`, `data?.tasks.length`.

## 3. Requirements

- Every nested optional field is guarded; no shape mismatch can throw.
- Loading, unavailable, stale, partial and error are **distinct** UI states.
- A value that is missing or unreadable never renders as a measured `0`, `PASS` or `UNKNOWN`.
- API-provided PASS / counts / services / modules render **accurately**.
- Partial `/runtime` data stays visible **with its real unavailability reason**.
- `generated_at` / source / staleness evidence is preserved and shown.
- Ellipsis and separator glyphs render as glyphs.

## 4. Approach

Frontend only, in three layers:

1. **Contract layer** (`skills/goviral.ts`) — retype against the shapes the backend actually
   emits, verified against live payloads.
2. **Normalization layer** (new, pure, `skills/goviral-normalize.ts`) — accept `unknown`,
   validate structurally, and return a discriminated
   `Availability = ready | partial | unavailable` view-model. Missing data becomes an explicit
   absence, never a zero. This is where the crash class is eliminated for good, and it is
   directly unit-testable without a DOM.
3. **Presentation layer** — the page and its sibling components consume only normalized
   view-models and render absence as `—` with an "unavailable" treatment plus the reason.

## 5. Testing

The web package is deliberately DOM-free (no jsdom/happy-dom, no Testing Library, no fetch
mocking anywhere) and tests pure functions extracted from components — the established
`pairToolEvents` / `skills/settings.ts` pattern. This repair follows that convention rather
than introducing a DOM harness inside a hotfix:

- **Schema/contract tests** — replay the captured live payloads plus degraded, truncated,
  null-heavy, wrong-type and empty variants through every normalizer.
- **Component-behaviour tests** — assert on the rendered view-model: which state each panel
  resolves to, that absence never becomes `0`/`PASS`/`UNKNOWN`, and that the `/runtime`
  `available:false` reason survives normalization.
- **Browser regression** — load the real console against the live read-only endpoints and
  assert no console exception and that API-provided values are on screen.

## 6. Rollback

The service runs in-place from the git checkout and **no existing backup covers
`packages/web/dist`**. That gap is closed as part of this work: the known-good dist is copied
to `/var/lib/goviral-archon/backups/web-dist/dist-<ts>` with a `previous` symlink before any
rebuild. Rollback is restoring that directory; no restart is required because the dist is
served from disk.

## 7. Out of scope

Backend route shapes (the more correct long-term fix is Zod-validated responses, and the
`/services/semantic` vs `/runtime` disagreement is a real backend inconsistency), the
duplicated systemd drop-in, and module staleness. Recorded here, not addressed.
