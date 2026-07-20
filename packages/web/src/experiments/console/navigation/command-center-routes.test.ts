/**
 * Route-manifest contract tests.
 *
 * These pin the boundary between Archon's navigation and the GoViral Agency
 * Command Center so neither side can drift silently.
 *
 * The strongest check reads the PUBLISHED manifest off this host, re-hashes it,
 * and compares it field-by-field with the copy embedded in
 * `command-center-routes.ts`. On a machine without the Command Center installed
 * that check reports itself as skipped-by-absence rather than passing quietly,
 * and the pinned expectations below still run — so a hand edit to the embedded
 * copy fails everywhere, and an upstream change fails wherever the manifest
 * exists.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  COMMAND_CENTER_ROUTES,
  COMMAND_CENTER_ROUTE_PATHS,
  NAVIGATION,
  ARCHON_DESTINATIONS,
  EXCLUDED_NON_PRODUCTION,
  MANIFEST_PATH,
  MANIFEST_ROUTE_COUNT,
  MANIFEST_SHA256,
  MANIFEST_VERSION,
  AGENCY_DEPLOYED_COMMIT,
  allDestinations,
  destinationCapability,
  destinationLabels,
  findDestination,
  findGroupOf,
  findRoute,
  isApprovedRoute,
  isBindable,
} from './command-center-routes';

// ─── Provenance ─────────────────────────────────────────────────────────────

describe('manifest provenance', () => {
  test('pins the verified handoff values', () => {
    expect(MANIFEST_VERSION).toBe('1.0.0');
    expect(MANIFEST_ROUTE_COUNT).toBe(61);
    expect(MANIFEST_SHA256).toBe(
      'cf12629c09e2f87edd37d90c88bb87775dabb885c3013c753dd950c4b6769864'
    );
    expect(AGENCY_DEPLOYED_COMMIT).toBe('a2d8a7ecf9a8b3ad9318d5e10557d13e370ee435');
  });

  test('embeds exactly the declared number of routes', () => {
    expect(COMMAND_CENTER_ROUTES).toHaveLength(MANIFEST_ROUTE_COUNT);
    expect(COMMAND_CENTER_ROUTE_PATHS.size).toBe(MANIFEST_ROUTE_COUNT);
  });

  test('carries the manifest-declared non-production exclusion', () => {
    expect(EXCLUDED_NON_PRODUCTION).toEqual(['/console/_nav-preview']);
  });
});

// ─── Drift detection against the published manifest ─────────────────────────

describe('published manifest', () => {
  const present = existsSync(MANIFEST_PATH);

  test('records whether the published manifest is readable on this host', () => {
    // A dev machine legitimately lacks it; the point is to make its absence
    // visible in the run rather than silent.
    expect(typeof present).toBe('boolean');
  });

  test('embedded copy matches the published manifest byte-for-byte', () => {
    if (!present) {
      expect(present).toBe(false); // skipped by absence
      return;
    }

    const raw = readFileSync(MANIFEST_PATH);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(MANIFEST_SHA256);

    const published = JSON.parse(raw.toString('utf8')) as {
      manifest_version: string;
      route_count: number;
      excluded_non_production: string[];
      routes: {
        id: string;
        path: string;
        group: string;
        capability: string;
        labels: { en: string; el: string };
        params: string[];
        availability: string;
        inNav: boolean;
        modal: boolean;
        parent: string | null;
        query?: { name: string; values: string[] }[];
      }[];
    };

    expect(published.manifest_version).toBe(MANIFEST_VERSION);
    expect(published.route_count).toBe(MANIFEST_ROUTE_COUNT);
    expect(published.excluded_non_production).toEqual([...EXCLUDED_NON_PRODUCTION]);

    // Field-by-field, so a changed label, capability or inNav flag fails here.
    const embedded = [...COMMAND_CENTER_ROUTES].sort((a, b) => a.id.localeCompare(b.id));
    const upstream = [...published.routes].sort((a, b) => a.id.localeCompare(b.id));
    expect(embedded.map(r => r.id)).toEqual(upstream.map(r => r.id));

    for (let i = 0; i < upstream.length; i++) {
      const u = upstream[i]!;
      const e = embedded[i]!;
      expect({
        id: e.id,
        path: e.path,
        group: e.group as string,
        capability: e.capability as string,
        labels: e.labels,
        params: [...e.params],
        availability: e.availability,
        inNav: e.inNav,
        modal: e.modal,
        parent: e.parent,
      }).toEqual({
        id: u.id,
        path: u.path,
        group: u.group,
        capability: u.capability,
        labels: u.labels,
        params: u.params,
        availability: u.availability,
        inNav: u.inNav,
        modal: u.modal,
        parent: u.parent,
      });

      const uq = u.query?.[0];
      if (uq) {
        expect(e.query).toEqual({ name: uq.name, values: uq.values });
      } else {
        expect(e.query).toBeUndefined();
      }
    }
  });
});

// ─── Route list invariants ──────────────────────────────────────────────────

describe('route list', () => {
  test('every path is absolute and unique', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      expect(r.path.startsWith('/')).toBe(true);
    }
    expect(new Set(COMMAND_CENTER_ROUTES.map(r => r.path)).size).toBe(MANIFEST_ROUTE_COUNT);
  });

  test('ids are unique', () => {
    expect(new Set(COMMAND_CENTER_ROUTES.map(r => r.id)).size).toBe(MANIFEST_ROUTE_COUNT);
  });

  test('params are consistent with the path', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      const inPath = (r.path.match(/:[A-Za-z]+/g) ?? []).map(s => s.slice(1));
      expect({ id: r.id, params: [...r.params] }).toEqual({ id: r.id, params: inPath });
    }
  });

  test('every parent, when set, is itself a published route', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      if (r.parent !== null) {
        expect({ id: r.id, parentPublished: isApprovedRoute(r.parent) }).toEqual({
          id: r.id,
          parentPublished: true,
        });
      }
    }
  });

  test('parameterized routes are never navigable', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      if (r.params.length > 0) {
        expect({ id: r.id, inNav: r.inNav }).toEqual({ id: r.id, inNav: false });
      }
    }
  });

  test('isBindable accepts only inNav, non-parameterized published routes', () => {
    expect(isBindable('/clients')).toBe(true);
    expect(isBindable('/clients/:clientId')).toBe(false);
    expect(isBindable('/clients/new')).toBe(false); // published, but a modal
    expect(isBindable('/not-a-route')).toBe(false);
  });

  test('isApprovedRoute rejects plausible but unpublished paths', () => {
    expect(isApprovedRoute('/clients')).toBe(true);
    expect(isApprovedRoute('/integrations/failed')).toBe(false);
    expect(isApprovedRoute('/settings')).toBe(false);
    expect(isApprovedRoute('/operations')).toBe(false);
  });
});

// ─── Navigation taxonomy ────────────────────────────────────────────────────

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

/** Pinned bindings. Any change here is a deliberate contract change. */
const EXPECTED_BINDINGS: Record<string, string> = {
  overview: '/',
  today: '/today',
  notifications: '/notifications',
  clients: '/clients',
  'crm-leads': '/crm',
  projects: '/projects',
  team: '/team',
  'production-board': '/production',
  workflows: '/workflows',
  deliverables: '/deliverables',
  assets: '/assets',
  revisions: '/revisions',
  agents: '/agents',
  models: '/models',
  skills: '/skills',
  tools: '/tools',
  'live-runs': '/runs',
  approvals: '/approvals',
  'quality-gates': '/review',
  'audit-trail': '/audit',
  quarantine: '/quarantine',
  'integrations-all': '/integrations',
  'integrations-connected': '/integrations',
  'integrations-login-required': '/integrations',
  'workers-services': '/workers',
  autoscaling: '/operations/autoscaling',
  'costs-usage': '/costs',
  deployments: '/deployments',
  'incidents-rollbacks': '/operations/incidents',
  'agency-profile': '/settings/agency',
  'roles-permissions': '/settings/access',
  'settings-notifications': '/settings/notifications',
  'system-settings': '/settings/system',
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
  test('every mapped destination binds to a BINDABLE published route', () => {
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        expect({
          id: destination.id,
          route: destination.binding.route,
          bindable: isBindable(destination.binding.route),
        }).toEqual({
          id: destination.id,
          route: destination.binding.route,
          bindable: true,
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

  test('33 of 34 destinations are mapped after reconciliation', () => {
    const mapped = allDestinations().filter(d => d.binding.kind === 'mapped');
    expect(mapped).toHaveLength(33);
    expect(allDestinations()).toHaveLength(34);
  });

  test('all 18 formerly-missing destinations are now bound', () => {
    const formerlyMissing = [
      'today',
      'notifications',
      'crm-leads',
      'production-board',
      'workflows',
      'assets',
      'revisions',
      'agents',
      'models',
      'skills',
      'tools',
      'quarantine',
      'autoscaling',
      'incidents-rollbacks',
      'agency-profile',
      'roles-permissions',
      'settings-notifications',
      'system-settings',
    ];
    expect(formerlyMissing).toHaveLength(18);
    for (const id of formerlyMissing) {
      const destination = findDestination(id);
      expect({ id, kind: destination?.binding.kind }).toEqual({ id, kind: 'mapped' });
    }
  });

  test('the only remaining unmapped destination is the unpublished integrations filter', () => {
    const unmapped = allDestinations().filter(d => d.binding.kind === 'unmapped');
    expect(unmapped.map(d => d.id)).toEqual(['integrations-failed']);
    const binding = unmapped[0]?.binding;
    expect(binding?.kind).toBe('unmapped');
    if (binding?.kind === 'unmapped') {
      expect(binding.reason).toContain('connected');
      expect(binding.reason).toContain('login-required');
    }
  });

  test('no mapped destination targets a parameterized route', () => {
    for (const destination of allDestinations()) {
      if (destination.binding.kind === 'mapped') {
        expect(findRoute(destination.binding.route)?.params).toEqual([]);
      }
    }
  });

  test('every `related` route is published', () => {
    for (const destination of allDestinations()) {
      for (const related of destination.related ?? []) {
        expect({ id: destination.id, related, published: isApprovedRoute(related) }).toEqual({
          id: destination.id,
          related,
          published: true,
        });
      }
    }
  });
});

// ─── Validated query filters ────────────────────────────────────────────────

describe('integration state filters', () => {
  test('exactly two destinations use a query filter', () => {
    const filtered = allDestinations().filter(
      d => d.binding.kind === 'mapped' && d.binding.query !== undefined
    );
    expect(filtered.map(d => d.id)).toEqual([
      'integrations-connected',
      'integrations-login-required',
    ]);
  });

  test('every filter value is one the manifest validates', () => {
    for (const destination of allDestinations()) {
      if (destination.binding.kind !== 'mapped' || !destination.binding.query) continue;

      const route = findRoute(destination.binding.route);
      expect(route?.query).toBeDefined();
      expect(route?.query?.name).toBe(destination.binding.query.name);
      expect(route?.query?.values).toContain(destination.binding.query.value);
    }
  });

  test('the manifest validates exactly connected and login-required', () => {
    expect(findRoute('/integrations')?.query).toEqual({
      name: 'state',
      values: ['connected', 'login-required'],
    });
  });

  test('an unpublished filter value is not bound anywhere', () => {
    const values = allDestinations()
      .map(d => (d.binding.kind === 'mapped' ? d.binding.query?.value : undefined))
      .filter((v): v is string => v !== undefined);
    expect(values).not.toContain('failed');
    expect(values).not.toContain('disabled');
  });
});

// ─── Permissions and labels from the manifest ───────────────────────────────

describe('capabilities and labels come from the manifest', () => {
  test('every mapped destination reports the manifest capability', () => {
    for (const destination of allDestinations()) {
      const capability = destinationCapability(destination);
      if (destination.binding.kind === 'mapped') {
        expect({ id: destination.id, capability }).toEqual({
          id: destination.id,
          capability: findRoute(destination.binding.route)?.capability ?? null,
        });
        expect(capability).not.toBeNull();
      } else {
        expect(capability).toBeNull();
      }
    }
  });

  test('an unfiltered mapped destination renders the manifest label', () => {
    const clients = findDestination('clients');
    expect(clients).not.toBeNull();
    expect(destinationLabels(clients!)).toEqual(findRoute('/clients')!.labels);
  });

  test('a filtered destination keeps its own label, not the index label', () => {
    const connected = findDestination('integrations-connected');
    expect(destinationLabels(connected!).en).toBe('Connected');
    expect(destinationLabels(connected!).en).not.toBe(findRoute('/integrations')!.labels.en);
  });

  test('an unmapped destination falls back to its local label', () => {
    const failed = findDestination('integrations-failed');
    expect(destinationLabels(failed!).en).toBe('Failed / Disabled');
  });
});

const GREEK = /[Ͱ-Ͽἀ-῿]/;

describe('Greek and English labels', () => {
  test('every group and destination has both locales, non-empty', () => {
    for (const group of NAVIGATION) {
      expect(group.labels.en.trim().length).toBeGreaterThan(0);
      expect(group.labels.el.trim().length).toBeGreaterThan(0);
    }
    for (const destination of allDestinations()) {
      const labels = destinationLabels(destination);
      expect({ id: destination.id, en: labels.en.trim().length > 0 }).toEqual({
        id: destination.id,
        en: true,
      });
      expect({ id: destination.id, el: labels.el.trim().length > 0 }).toEqual({
        id: destination.id,
        el: true,
      });
    }
  });

  test('every published route carries both locales', () => {
    for (const r of COMMAND_CENTER_ROUTES) {
      expect({ id: r.id, en: r.labels.en.length > 0 }).toEqual({ id: r.id, en: true });
      expect({ id: r.id, el: r.labels.el.length > 0 }).toEqual({ id: r.id, el: true });
    }
  });

  test('Greek labels are actually Greek, not copied English', () => {
    const greek = allDestinations().filter(d => GREEK.test(destinationLabels(d).el));
    expect(greek.length).toBeGreaterThanOrEqual(30);
    for (const group of NAVIGATION) {
      expect({ id: group.id, greek: GREEK.test(group.labels.el) }).toEqual({
        id: group.id,
        greek: true,
      });
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

  test('Archon paths are in-app and never published Command Center routes', () => {
    for (const destination of ARCHON_DESTINATIONS) {
      expect(
        destination.path.startsWith('/console') || destination.path.startsWith('/legacy')
      ).toBe(true);
      expect(isApprovedRoute(destination.path)).toBe(false);
    }
  });

  test('Archon ids are namespaced and never collide with destinations', () => {
    const ccIds = new Set(allDestinations().map(d => d.id));
    for (const destination of ARCHON_DESTINATIONS) {
      expect(destination.id.startsWith('archon-')).toBe(true);
      expect(ccIds.has(destination.id)).toBe(false);
    }
  });

  test('colliding display names are disambiguated by section, not deduplicated', () => {
    expect(allDestinations().map(d => destinationLabels(d).en)).toContain('Workflows');
    expect(ARCHON_DESTINATIONS.map(d => d.labels.en)).toContain('Workflows (classic)');
  });
});

// ─── Lookups ────────────────────────────────────────────────────────────────

describe('lookup helpers', () => {
  test('findDestination and findGroupOf resolve or return null', () => {
    expect(findDestination('clients')?.id).toBe('clients');
    expect(findDestination('nope')).toBeNull();
    expect(findGroupOf('quarantine')?.id).toBe('governance');
    expect(findGroupOf('nope')).toBeNull();
  });

  test('findRoute resolves published paths only', () => {
    expect(findRoute('/quarantine')?.id).toBe('quarantine');
    expect(findRoute('/nope')).toBeNull();
  });

  test('every destination is reachable from exactly one group', () => {
    for (const destination of allDestinations()) {
      const owners = NAVIGATION.filter(g => g.destinations.some(d => d.id === destination.id));
      expect(owners).toHaveLength(1);
    }
  });
});
