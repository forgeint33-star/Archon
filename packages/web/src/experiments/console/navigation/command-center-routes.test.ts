/**
 * Route-manifest contract tests.
 *
 * These pin the boundary between Archon's navigation and the GoViral Agency
 * Command Center so neither side can drift silently. If the Command Center's
 * approved IA changes, or someone edits a binding or label here, these fail.
 *
 * The pinned values transcribe the approved PRD
 * (.planning/prds/draft/2026-07-19-goviral-agency-command-center-v1.md:176-224,
 * approved by commit 51a4e97). Updating them is allowed only when the upstream
 * contract actually changed — that is the point of pinning.
 */

import { describe, test, expect } from 'bun:test';
import {
  COMMAND_CENTER_ROUTES,
  COMMAND_CENTER_ROUTE_PATHS,
  NAVIGATION,
  ARCHON_DESTINATIONS,
  allDestinations,
  findDestination,
  findGroupOf,
  isApprovedRoute,
  type CommandCenterArea,
} from './command-center-routes';

// ─── The approved route list ────────────────────────────────────────────────

/** Verbatim from PRD:176-224. */
const APPROVED_PATHS = [
  '/',
  '/health',
  '/clients',
  '/clients/new',
  '/clients/:id',
  '/clients/:id/contacts',
  '/clients/:id/contracts',
  '/projects',
  '/projects/new',
  '/projects/:id',
  '/projects/:id/board',
  '/projects/:id/timeline',
  '/templates',
  '/runs',
  '/runs/:id',
  '/runs/:id/events',
  '/runs/:id/outputs',
  '/workers',
  '/review',
  '/review/:runId',
  '/review/:runId/rework',
  '/quality/history',
  '/approvals',
  '/approvals/:id',
  '/approvals/history',
  '/deliverables',
  '/deliverables/:id',
  '/deliverables/:id/compare',
  '/deliverables/:id/delivery',
  '/clients/:id/assets',
  '/clients/:id/assets/:assetId',
  '/clients/:id/brand',
  '/integrations',
  '/integrations/:name',
  '/integrations/auth',
  '/costs',
  '/costs/budgets',
  '/costs/margin',
  '/deployments',
  '/deployments/:id',
  '/communications',
  '/team',
  '/audit',
];

/** PRD:178 — "43 routes across 14 areas". */
const EXPECTED_ROUTE_COUNT = 43;

const EXPECTED_AREA_COUNTS: Record<CommandCenterArea, number> = {
  A: 2,
  B: 5,
  C: 6,
  D: 5,
  E: 4,
  F: 3,
  G: 4,
  H: 3,
  I: 3,
  J: 3,
  K: 2,
  L: 1,
  M: 1,
  N: 1,
};

describe('approved Command Center route list', () => {
  test('holds exactly the 43 routes the PRD defines', () => {
    expect(COMMAND_CENTER_ROUTES).toHaveLength(EXPECTED_ROUTE_COUNT);
    expect(COMMAND_CENTER_ROUTES.map(r => r.path)).toEqual(APPROVED_PATHS);
  });

  test('per-area counts match the PRD headings', () => {
    const counts = {} as Record<CommandCenterArea, number>;
    for (const r of COMMAND_CENTER_ROUTES) {
      counts[r.area] = (counts[r.area] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_AREA_COUNTS);
    expect(Object.values(EXPECTED_AREA_COUNTS).reduce((a, b) => a + b, 0)).toBe(
      EXPECTED_ROUTE_COUNT
    );
  });

  test('contains no duplicate paths', () => {
    expect(COMMAND_CENTER_ROUTE_PATHS.size).toBe(EXPECTED_ROUTE_COUNT);
  });

  test('parameterization is derived, not asserted by hand', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      expect(r.parameterized).toBe(r.path.includes(':'));
    }
    expect(COMMAND_CENTER_ROUTES.filter(r => r.parameterized)).toHaveLength(20);
  });

  test('every path is absolute', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      expect(r.path.startsWith('/')).toBe(true);
    }
  });

  test('isApprovedRoute accepts approved paths and rejects invented ones', () => {
    expect(isApprovedRoute('/clients')).toBe(true);
    expect(isApprovedRoute('/audit')).toBe(true);
    // Plausible-looking paths that the IA does NOT define.
    expect(isApprovedRoute('/crm/leads')).toBe(false);
    expect(isApprovedRoute('/agents')).toBe(false);
    expect(isApprovedRoute('/quarantine')).toBe(false);
    expect(isApprovedRoute('/settings')).toBe(false);
  });
});

// ─── Navigation taxonomy ────────────────────────────────────────────────────

/** The owner's eight groups, in order. */
const EXPECTED_GROUPS = [
  'home',
  'agency',
  'production',
  'ai-workforce',
  'governance',
  'integrations',
  'operations',
  'settings',
];

/** The owner's 34 destinations, in order, per group. */
const EXPECTED_DESTINATIONS: Record<string, string[]> = {
  home: ['overview', 'today', 'notifications'],
  agency: ['clients', 'crm-leads', 'projects', 'team'],
  production: ['production-board', 'workflows', 'deliverables', 'assets', 'revisions'],
  'ai-workforce': ['agents', 'models', 'skills', 'tools', 'live-runs'],
  governance: ['approvals', 'quality-gates', 'audit-trail', 'quarantine'],
  integrations: [
    'integrations-all',
    'integrations-connected',
    'integrations-login-required',
    'integrations-failed',
  ],
  operations: [
    'workers-services',
    'autoscaling',
    'costs-usage',
    'deployments',
    'incidents-rollbacks',
  ],
  settings: ['agency-profile', 'roles-permissions', 'settings-notifications', 'system-settings'],
};

/**
 * The mapped bindings, pinned. Changing any of these is a contract change and
 * must be a deliberate edit reviewed against the upstream IA.
 */
const EXPECTED_BINDINGS: Record<string, string> = {
  overview: '/',
  clients: '/clients',
  projects: '/projects',
  team: '/team',
  deliverables: '/deliverables',
  'live-runs': '/runs',
  approvals: '/approvals',
  'quality-gates': '/review',
  'audit-trail': '/audit',
  'integrations-all': '/integrations',
  'integrations-login-required': '/integrations/auth',
  'workers-services': '/workers',
  'costs-usage': '/costs',
  deployments: '/deployments',
};

describe('navigation taxonomy', () => {
  test('has the owner-specified eight groups in order', () => {
    expect(NAVIGATION.map(g => g.id)).toEqual(EXPECTED_GROUPS);
  });

  test('has the owner-specified 34 destinations in order', () => {
    for (const group of NAVIGATION) {
      expect(group.destinations.map(d => d.id)).toEqual(EXPECTED_DESTINATIONS[group.id]);
    }
    expect(allDestinations()).toHaveLength(34);
  });

  test('destination ids are globally unique', () => {
    const ids = allDestinations().map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── The binding contract — the anti-drift core ─────────────────────────────

describe('binding contract', () => {
  test('every mapped destination points at an APPROVED route', () => {
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        expect({
          id: destination.id,
          route: destination.binding.route,
          approved: isApprovedRoute(destination.binding.route),
        }).toEqual({
          id: destination.id,
          route: destination.binding.route,
          approved: true,
        });
      }
    }
  });

  test('mapped bindings match the pinned contract exactly', () => {
    const actual: Record<string, string> = {};
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        actual[destination.id] = destination.binding.route;
      }
    }
    expect(actual).toEqual(EXPECTED_BINDINGS);
  });

  test('exactly 14 of 34 destinations are mapped — the rest await upstream routes', () => {
    const mapped = allDestinations().filter(d => d.binding.kind === 'mapped');
    expect(mapped).toHaveLength(14);
    expect(allDestinations()).toHaveLength(34);
  });

  test('no mapped destination targets a parameterized route', () => {
    const byPath = new Map(COMMAND_CENTER_ROUTES.map(r => [r.path, r]));
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        expect(byPath.get(destination.binding.route)?.parameterized).toBe(false);
      }
    }
  });

  test('every unmapped destination states a real reason', () => {
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'unmapped') {
        expect(destination.binding.reason.length).toBeGreaterThan(10);
        // The reason must explain, not just restate the state.
        expect(destination.binding.reason.toLowerCase()).not.toBe('unmapped');
      }
    }
  });

  test('every `related` route is also approved', () => {
    for (const destination of allDestinations()) {
      for (const related of destination.related ?? []) {
        expect({ id: destination.id, related, approved: isApprovedRoute(related) }).toEqual({
          id: destination.id,
          related,
          approved: true,
        });
      }
    }
  });

  test('no two destinations claim the same route', () => {
    const routes = allDestinations()
      .map(d => (d.binding.kind === 'mapped' ? d.binding.route : null))
      .filter((r): r is string => r !== null);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

// ─── Bilingual labels ───────────────────────────────────────────────────────

const GREEK = /[Ͱ-Ͽἀ-῿]/;

describe('Greek and English labels', () => {
  test('every group has non-empty labels in both locales', () => {
    for (const group of NAVIGATION) {
      expect(group.labels.en.length).toBeGreaterThan(0);
      expect(group.labels.el.length).toBeGreaterThan(0);
    }
  });

  test('every destination has non-empty labels in both locales', () => {
    for (const destination of allDestinations()) {
      expect({ id: destination.id, en: destination.labels.en.length > 0 }).toEqual({
        id: destination.id,
        en: true,
      });
      expect({ id: destination.id, el: destination.labels.el.length > 0 }).toEqual({
        id: destination.id,
        el: true,
      });
    }
  });

  test('Greek labels actually contain Greek script, not copied English', () => {
    // Latin-script product nouns are legitimately untranslated (CRM, Archon),
    // so this asserts the majority rather than every single label.
    const greekLabels = allDestinations().filter(d => GREEK.test(d.labels.el));
    expect(greekLabels.length).toBeGreaterThanOrEqual(30);

    for (const group of NAVIGATION) {
      expect({ id: group.id, greek: GREEK.test(group.labels.el) }).toEqual({
        id: group.id,
        greek: true,
      });
    }
  });

  test('every Archon destination is bilingual too', () => {
    for (const destination of ARCHON_DESTINATIONS) {
      expect(destination.labels.en.length).toBeGreaterThan(0);
      expect(destination.labels.el.length).toBeGreaterThan(0);
    }
  });
});

// ─── Archon section separation ──────────────────────────────────────────────

describe('Archon routes stay separate from Command Center groups', () => {
  test('no Command Center destination points at an Archon in-app path', () => {
    const archonPaths = new Set(ARCHON_DESTINATIONS.map(d => d.path));
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        expect(archonPaths.has(destination.binding.route)).toBe(false);
      }
    }
  });

  test('Archon paths are in-app absolute paths under a known prefix', () => {
    for (const destination of ARCHON_DESTINATIONS) {
      expect(
        destination.path.startsWith('/console') || destination.path.startsWith('/legacy')
      ).toBe(true);
    }
  });

  test('Archon destination ids are unique and namespaced', () => {
    const ids = ARCHON_DESTINATIONS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith('archon-')).toBe(true);
    }
  });

  test('Archon ids never collide with Command Center destination ids', () => {
    const ccIds = new Set(allDestinations().map(d => d.id));
    for (const destination of ARCHON_DESTINATIONS) {
      expect(ccIds.has(destination.id)).toBe(false);
    }
  });

  test('colliding display names are disambiguated by section, not deduplicated', () => {
    // "Workflows" exists in both worlds on purpose: Archon's own builder and
    // the Command Center's production concept. The group heading separates them.
    const ccLabels = allDestinations().map(d => d.labels.en);
    expect(ccLabels).toContain('Workflows');
    expect(ARCHON_DESTINATIONS.map(d => d.labels.en)).toContain('Workflows (classic)');
  });
});

// ─── Lookups ────────────────────────────────────────────────────────────────

describe('lookup helpers', () => {
  test('findDestination resolves a known id and returns null otherwise', () => {
    expect(findDestination('clients')?.labels.en).toBe('Clients');
    expect(findDestination('nope')).toBeNull();
  });

  test('findGroupOf resolves the owning group and returns null otherwise', () => {
    expect(findGroupOf('quarantine')?.id).toBe('governance');
    expect(findGroupOf('nope')).toBeNull();
  });

  test('every destination is reachable from exactly one group', () => {
    for (const destination of allDestinations()) {
      const owners = NAVIGATION.filter(g => g.destinations.some(d => d.id === destination.id));
      expect(owners).toHaveLength(1);
    }
  });
});
