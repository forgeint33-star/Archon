# PRD — Archon UX Navigation Bridge

- **Status:** approved by owner, scoped, frontend-only, **not deployed**
- **Date:** 2026-07-19
- **Surface:** `packages/web/src/experiments/console/` (Archon console shell)
- **Change class:** additive navigation shell. No backend, systemd, database, worker,
  quarantine or credential change. Not activated.

## 1. Owner approval (recorded)

The owner explicitly authorized one governed, frontend-only Archon UX Navigation Bridge for
the GoViral Agency Command Center, to be built in `/opt/goviral-archon-src`, modifying only
the owned Archon fork and never pushing to `coleam00/archon`. Authorized: read the Agency
Command Center's approved PRD and route contracts **read-only**; build a premium grouped
navigation shell over eight categories; add route-manifest contract tests, component,
accessibility and browser E2E tests; build as `goviral-archon`, never root; commit to an owned
feature branch and stop release-ready.

Explicitly prohibited: modifying the GoViral repository; deploying or activating the bridge;
restarting Archon; connector logins, external writes or paid actions; modifying backend,
systemd, databases, workers, quarantine or credentials; pushing to the third-party origin.

## 2. Source of truth, and what it does and does not contain

The Agency Command Center is being implemented concurrently. On this host it lives at
`/var/lib/goviral-archon/worktrees/goviral-brain-runtime-v1/apps/command-center`, on branch
`goviral/real-multi-agent-runtime-v1`. All of it was read strictly read-only; nothing in that
repository was modified.

Two facts govern this design:

1. **The approved contract is the PRD's Information Architecture, not code.** The PRD
   `.planning/prds/draft/2026-07-19-goviral-agency-command-center-v1.md:176-224` defines
   **43 routes across 14 areas (A–N)**, and it is approved and committed
   (`.governance/approvals/2026-07-19-agency-command-center-approval.md`, commit `51a4e97`).
   That IA is what this bridge binds to.
2. **The Command Center router does not exist yet, and its branch is unpushed.**
   `web/src/` contains only `lib/api.ts`, `lib/api.test.ts`, `lib/state.tsx`. There is no
   `App.tsx`, no router, no routes manifest, no nav config. `git branch -r --contains HEAD`
   is empty. Per the owner's instruction not to depend on uncommitted implementation details,
   **this bridge binds only to the committed PRD IA and ignores the unpushed implementation.**

### The gap — stated plainly

The owner specified 8 groups and 34 destinations. The approved IA is a 14-area / 43-route
taxonomy. They are different shapes, and **only 14 of the 34 destinations have an approved,
navigable (non-parameterized) route**:

| Destination                   | Approved route       |
| ----------------------------- | -------------------- |
| Overview                      | `/`                  |
| Clients                       | `/clients`           |
| Projects                      | `/projects`          |
| Team                          | `/team`              |
| Deliverables                  | `/deliverables`      |
| Live Runs                     | `/runs`              |
| Approvals                     | `/approvals`         |
| Quality Gates                 | `/review`            |
| Audit Trail                   | `/audit`             |
| Integrations · All            | `/integrations`      |
| Integrations · Login Required | `/integrations/auth` |
| Workers & Services            | `/workers`           |
| Costs & Usage                 | `/costs`             |
| Deployments                   | `/deployments`       |

The remaining **20 destinations have no approved route** — the complete list: Today,
Notifications, CRM & Leads, Production Board, Workflows, Assets, Revisions, Agents, Models,
Skills, Tools, Quarantine, Integrations · Connected, Integrations · Failed/Disabled,
Autoscaling, Incidents & Rollbacks, Agency Profile, Roles & Permissions,
Settings · Notifications, System Settings.

Some are close to a _parameterized_ route but not navigable without an id — Production Board
exists only as `/projects/:id/board`, Assets only as `/clients/:id/assets`, Revisions only as
`/deliverables/:id/compare`. A top-level nav item cannot link to those without inventing an id.

**No route is invented to close this gap.** Inventing paths would produce exactly the class of
defect the Control Plane hotfix just removed: a frontend asserting a contract the backend never
agreed to. Instead every destination carries an explicit binding state, and unmapped
destinations render as visibly pending — never as a link.

## 3. Design

Three layers, all under `experiments/console/` and lint-isolated from production web modules.

**Route manifest** (`navigation/command-center-routes.ts`) — one pure module holding:

- `COMMAND_CENTER_ROUTES`: all 43 approved PRD routes, verbatim, with their area letter.
- `NAVIGATION`: the owner's 8 groups × 34 destinations, each with `id`, EL + EN labels, icon,
  and a discriminated binding:
  - `{ kind: 'mapped', route }` — `route` must exist in `COMMAND_CENTER_ROUTES`.
  - `{ kind: 'unmapped', reason }` — the honest reason no route exists yet.

A destination cannot be `mapped` to a path absent from the approved list; the contract test
enforces it. This is the anti-drift mechanism: if the Command Center changes its IA, or someone
edits a label or binding here, the pinned test fails.

**Availability** (`navigation/command-center-health.ts`) — one configurable base URL
(`VITE_COMMAND_CENTER_URL`, default `http://127.0.0.1:8181`) and a probe of the Command
Center's implemented health endpoint `GET /api/v1/health`
(`apps/command-center/api/goviral_cc/app.py:45,278`; note `/api/v1/health/runtime` is specified
at PRD:655 but **not implemented**, so it is not probed). Probe outcome is a discriminated
state: `probing | available | unavailable(reason)`. Links are feature-flagged **off** until the
probe succeeds. An unavailable Command Center produces exactly one honest banner carrying the
real reason — never broken links, never fabricated zero metrics.

**Shell** (`navigation/*.tsx`) — collapsible grouped sidebar with icons and live status badges,
`⌘K`/`Ctrl+K` command palette, breadcrumbs, recent and favourite destinations, responsive
desktop/tablet/mobile, full keyboard navigation and WCAG 2.1 AA.

Native Archon routes are **not** intermixed. They keep their own terminal `Archon` section, so
no Archon screen is duplicated inside a GoViral group and no GoViral destination is confused
for a native one. Archon owns Runs, Workflows, Builder, Control Plane, Settings; the Command
Center owns the agency business surfaces. Where names collide (Workflows, Approvals,
Deliverables), the group heading disambiguates.

Bilingual labels are a local EL/EN record in the manifest, not a new i18n dependency — the
Command Center has not yet chosen an i18n library (its PRD requires EL/EN at `:717-718` but
names no library), and picking one for it from inside Archon would pre-empt that decision.

## 4. Testing

- **Route-manifest contract tests** — pin all 43 approved routes and all 34 destination
  bindings so neither side can drift silently; assert every `mapped` route exists in the
  approved list; assert EL and EN labels exist and are non-empty for all 34.
- **Component tests** — pure view-model functions (group collapse, palette filtering,
  breadcrumb derivation, recents/favourites, badge state) in the repo's DOM-free idiom.
- **Accessibility tests** — roles, labels, `aria-current`, `aria-expanded`, focus order and
  keyboard reachability asserted over the rendered structure.
- **Browser E2E** — real browser against the built shell: keyboard-only traversal, palette
  open/filter/dismiss, responsive breakpoints, and the honest-unavailable state with the
  Command Center down (its expected state here — nothing is started).

## 5. Rollback and activation

Nothing is deployed, activated or restarted. The bridge is additive and unreferenced by the
live console until a follow-up change mounts it. Rollback is reverting the commit. The Control
Plane contract hotfix (`6bcd5900`) is preserved and untouched — this branch is cut from it.

## 6. Follow-up required before activation

1. **Close the 20-destination route gap** with the Command Center owner — either the IA grows
   the routes, or the navigation drops/merges those destinations. This is a product decision
   and is deliberately not made here.
2. Confirm the deployed Command Center base URL. `127.0.0.1:8181` is the only value in that
   repo (`web/vite.config.ts:9`); there is no `.env.example`, docker-compose or systemd unit
   for it.
3. **The Command Center must send CORS headers for the Archon origin.** Found during browser
   E2E: the health probe is cross-origin, so the browser blocks the response unless
   `Access-Control-Allow-Origin` names Archon's origin. Without it the probe fails with a bare
   `TypeError: Failed to fetch`, indistinguishable from the service being down — so the bridge
   would correctly, but permanently, report the Command Center as unavailable and keep every
   link disabled. The probe now says so explicitly ("it is down, or it is not sending CORS
   headers for this origin") rather than guessing, but **this must be fixed on the Command
   Center side before activation** or the bridge can never enable its links. The alternatives —
   `mode: 'no-cors'` (opaque response, status always 0, cannot tell healthy from broken) or
   proxying the probe through Archon's backend (out of the frontend-only scope granted here) —
   were both rejected as dishonest or out of scope.
4. Re-run the manifest contract test once the Command Center router lands, to reconcile the
   implemented routes against the PRD IA.
