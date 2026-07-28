/**
 * Behaviour tests for the navigation bridge view-model and health probe.
 *
 * The web package has no DOM environment by design (no jsdom/happy-dom, no
 * Testing Library), so component behaviour is asserted through the pure
 * view-model the components render from — the same idiom as pairToolEvents and
 * skills/settings.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  NAVIGATION,
  allDestinations,
  findDestination,
  type Destination,
} from './command-center-routes';
import {
  classifyProbe,
  destinationUrl,
  healthUrl,
  linksEnabled,
  probeCommandCenter,
  PROBING,
  type Availability,
} from './command-center-health';
import {
  breadcrumbsFor,
  clampIndex,
  coverage,
  groupBadge,
  isActionable,
  itemState,
  parseCollapsed,
  parseIdList,
  pushRecent,
  resolveIds,
  searchArchon,
  searchDestinations,
  serializeCollapsed,
  subsequence,
  toggleCollapsed,
  toggleFavourite,
  MAX_RECENTS,
} from './navigation-model';

const AVAILABLE: Availability = { kind: 'available', checkedAt: '2026-07-19T20:00:00.000Z' };
const OFFLINE: Availability = {
  kind: 'unavailable',
  reason: 'connect ECONNREFUSED 127.0.0.1:8181',
  checkedAt: '2026-07-19T20:00:00.000Z',
};

const mappedDestination = (): Destination => {
  const d = findDestination('clients');
  if (!d) throw new Error('fixture missing');
  return d;
};

const unmappedDestination = (): Destination => {
  // Quarantine is published in manifest 1.0.0; the failed/disabled integration
  // filter is the one destination the Command Center still does not offer.
  const d = findDestination('integrations-failed');
  if (!d) throw new Error('fixture missing');
  return d;
};

// ─── Feature flagging ───────────────────────────────────────────────────────

describe('links are feature-flagged on the health probe', () => {
  test('only the available state enables links', () => {
    expect(linksEnabled(AVAILABLE)).toBe(true);
    expect(linksEnabled(PROBING)).toBe(false);
    expect(linksEnabled(OFFLINE)).toBe(false);
  });

  test('a mapped destination is a link ONLY when the Command Center is up', () => {
    const destination = mappedDestination();
    expect(itemState(destination, AVAILABLE)).toEqual({
      kind: 'ready',
      href: 'http://127.0.0.1:8280/clients',
    });
    expect(itemState(destination, PROBING).kind).toBe('probing');
    expect(itemState(destination, OFFLINE).kind).toBe('offline');
  });

  test('an offline item carries the REAL reason, not a placeholder', () => {
    const state = itemState(mappedDestination(), OFFLINE);
    expect(state.kind).toBe('offline');
    if (state.kind === 'offline') {
      expect(state.reason).toBe('connect ECONNREFUSED 127.0.0.1:8181');
    }
  });

  test('an unmapped destination is never a link, even when the Command Center is up', () => {
    const state = itemState(unmappedDestination(), AVAILABLE);
    expect(state.kind).toBe('unmapped');
    expect(isActionable(state)).toBe(false);
  });

  test('unmapped outranks offline — the contract gap is the more useful truth', () => {
    expect(itemState(unmappedDestination(), OFFLINE).kind).toBe('unmapped');
  });

  test('NO destination is actionable while the Command Center is unavailable', () => {
    for (const destination of allDestinations()) {
      expect(isActionable(itemState(destination, OFFLINE))).toBe(false);
      expect(isActionable(itemState(destination, PROBING))).toBe(false);
    }
  });

  test('exactly the mapped destinations become actionable when it is available', () => {
    const actionable = allDestinations().filter(d => isActionable(itemState(d, AVAILABLE)));
    expect(actionable).toHaveLength(34);
  });
});

// ─── URL construction ───────────────────────────────────────────────────────

describe('destination URLs', () => {
  test('joins base and route without doubling the slash', () => {
    expect(destinationUrl('/clients', 'http://cc.example')).toBe('http://cc.example/clients');
    expect(destinationUrl('/clients', 'http://cc.example/')).toBe('http://cc.example/clients');
    expect(destinationUrl('/clients', 'http://cc.example///')).toBe('http://cc.example/clients');
  });

  test('the root route keeps a single trailing slash', () => {
    expect(destinationUrl('/', 'http://cc.example')).toBe('http://cc.example/');
    expect(destinationUrl('/', 'http://cc.example/')).toBe('http://cc.example/');
  });

  test('a validated filter becomes a query string, not a fabricated path', () => {
    expect(
      destinationUrl('/integrations', 'http://cc.example', { name: 'state', value: 'connected' })
    ).toBe('http://cc.example/integrations?state=connected');
    expect(
      destinationUrl('/integrations', 'http://cc.example', {
        name: 'state',
        value: 'login-required',
      })
    ).toBe('http://cc.example/integrations?state=login-required');
  });

  test('filter values are URL-encoded', () => {
    expect(
      destinationUrl('/integrations', 'http://cc.example', { name: 'state', value: 'a b&c' })
    ).toBe('http://cc.example/integrations?state=a%20b%26c');
  });

  test('the filtered destinations resolve to the query URL end-to-end', () => {
    const connected = findDestination('integrations-connected');
    const state = itemState(connected!, AVAILABLE);
    expect(state).toEqual({
      kind: 'ready',
      href: 'http://127.0.0.1:8280/integrations?state=connected',
    });
  });

  test('health URL targets the IMPLEMENTED endpoint', () => {
    expect(healthUrl('http://cc.example')).toBe('http://cc.example/api/v1/health');
    // /api/v1/health/runtime is specified but unimplemented; must not be probed.
    expect(healthUrl('http://cc.example')).not.toContain('/runtime');
  });
});

// ─── Probe classification ───────────────────────────────────────────────────

describe('probe classification', () => {
  const at = '2026-07-19T20:00:00.000Z';

  test('2xx WITH ready=true is available', () => {
    expect(classifyProbe({ ok: true, status: 200, ready: true }, at)).toEqual({
      kind: 'available',
      checkedAt: at,
    });
  });

  test('2xx WITHOUT ready=true is NOT available — liveness is not readiness', () => {
    const missing = classifyProbe({ ok: true, status: 200 }, at);
    expect(missing.kind).toBe('unavailable');
    if (missing.kind === 'unavailable') {
      expect(missing.reason).toContain('no `ready` field');
    }

    const notReady = classifyProbe({ ok: true, status: 200, ready: false }, at);
    expect(notReady.kind).toBe('unavailable');
    if (notReady.kind === 'unavailable') {
      expect(notReady.reason).toContain('ready=false');
    }
  });

  test('a truthy-but-not-true ready value is refused', () => {
    for (const ready of ['true', 1, {}, []]) {
      expect(classifyProbe({ ok: true, status: 200, ready }, at).kind).toBe('unavailable');
    }
  });

  test('non-2xx is unavailable and names the status', () => {
    const state = classifyProbe({ ok: true, status: 503, ready: true }, at);
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toBe('Readiness check returned HTTP 503');
    }
  });

  test('a 3xx redirect is NOT treated as healthy', () => {
    expect(classifyProbe({ ok: true, status: 302, ready: true }, at).kind).toBe('unavailable');
  });

  test('a transport failure preserves the underlying error', () => {
    const state = classifyProbe({ ok: false, error: 'getaddrinfo ENOTFOUND cc' }, at);
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toBe('getaddrinfo ENOTFOUND cc');
    }
  });

  test('every outcome records when it was checked', () => {
    expect(classifyProbe({ ok: true, status: 200, ready: true }, at)).toHaveProperty(
      'checkedAt',
      at
    );
    expect(classifyProbe({ ok: false, error: 'x' }, at)).toHaveProperty('checkedAt', at);
  });
});

// ─── The probe itself ───────────────────────────────────────────────────────

/**
 * `probeCommandCenter` must never throw and never report `available` on a
 * failure path — the whole feature flag rests on that.
 */
describe('probeCommandCenter', () => {
  const withFetch = async (
    impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
    run: () => Promise<Availability>
  ): Promise<Availability> => {
    const original = globalThis.fetch;
    globalThis.fetch = impl as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  test('a 200 with ready:true makes the Command Center available', async () => {
    const state = await withFetch(
      () => Promise.resolve(Response.json({ ready: true })),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('available');
  });

  test('a 200 with ready:false keeps links disabled', async () => {
    const state = await withFetch(
      () => Promise.resolve(Response.json({ ready: false, problems: ['schema'] })),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
  });

  test('a 200 with an unparseable body fails closed', async () => {
    const state = await withFetch(
      () => Promise.resolve(new Response('not json', { status: 200 })),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
  });

  test('a 500 is unavailable, carrying the status', async () => {
    const state = await withFetch(
      () => Promise.resolve(new Response('boom', { status: 500 })),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toContain('500');
    }
  });

  test('a refused connection is unavailable, carrying the real error', async () => {
    const state = await withFetch(
      () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8181')),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toBe('connect ECONNREFUSED 127.0.0.1:8181');
    }
  });

  test('a hang aborts and reports a timeout rather than pending forever', async () => {
    const state = await withFetch(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      () => probeCommandCenter('http://cc.example', 20)
    );
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toContain('timed out');
    }
  });

  test('it probes the READINESS path on the configured base URL', async () => {
    let seen = '';
    await withFetch(
      input => {
        seen = String(input);
        return Promise.resolve(Response.json({ ready: true }));
      },
      () => probeCommandCenter('http://cc.example')
    );
    expect(seen).toBe('http://cc.example/api/v1/ready');
  });

  test('it never sends Archon credentials to the other origin', async () => {
    let credentials: RequestCredentials | undefined;
    await withFetch(
      (_input, init) => {
        credentials = init?.credentials;
        return Promise.resolve(Response.json({ ready: true }));
      },
      () => probeCommandCenter('http://cc.example')
    );
    expect(credentials).toBe('omit');
  });

  test('a CORS block names CORS as a possibility, not a bare "Failed to fetch"', async () => {
    // A cross-origin block rejects with TypeError: Failed to fetch, which is
    // indistinguishable from the host being down. The message must say both.
    const corsError = new TypeError('Failed to fetch');
    const state = await withFetch(
      () => Promise.reject(corsError),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
    if (state.kind === 'unavailable') {
      expect(state.reason).toContain('CORS');
      expect(state.reason).toContain('down');
    }
  });

  test('a thrown non-Error still resolves to unavailable, never a rejection', async () => {
    const state = await withFetch(
      () => Promise.reject(new Error('')),
      () => probeCommandCenter('http://cc.example')
    );
    expect(state.kind).toBe('unavailable');
  });
});

// ─── Badges and coverage ────────────────────────────────────────────────────

describe('group badges report coverage, never a health metric', () => {
  test('badge counts partition the group', () => {
    for (const group of NAVIGATION) {
      const badge = groupBadge(group);
      expect(badge.mapped + badge.unmapped).toBe(badge.total);
      expect(badge.total).toBe(group.destinations.length);
    }
  });

  test('overall coverage is 33 of 34 after reconciliation', () => {
    expect(coverage()).toEqual({ mapped: 33, unmapped: 1, total: 34 });
  });

  test('a fully mapped group reports no gap', () => {
    const aiWorkforce = NAVIGATION.find(g => g.id === 'ai-workforce');
    expect(aiWorkforce).toBeDefined();
    expect(groupBadge(aiWorkforce!)).toEqual({ mapped: 5, unmapped: 0, total: 5 });
  });

  test('the only group with a gap is integrations', () => {
    const withGap = NAVIGATION.filter(g => groupBadge(g).unmapped > 0).map(g => g.id);
    expect(withGap).toEqual(['integrations']);
  });
});

// ─── Group collapse ─────────────────────────────────────────────────────────

describe('group collapse state', () => {
  test('round-trips through storage', () => {
    const collapsed = new Set(['home', 'settings']);
    expect(parseCollapsed(serializeCollapsed(collapsed))).toEqual(collapsed);
  });

  test('toggling adds then removes', () => {
    const once = toggleCollapsed(new Set(), 'home');
    expect(once.has('home')).toBe(true);
    expect(toggleCollapsed(once, 'home').has('home')).toBe(false);
  });

  test('corrupt or hostile storage degrades to nothing collapsed, never throws', () => {
    for (const raw of [null, '', 'not json', '{"a":1}', '[1,2,3]', 'null', '"home"']) {
      expect(() => parseCollapsed(raw)).not.toThrow();
      expect(parseCollapsed(raw).size).toBe(0);
    }
  });

  test('unknown group ids are dropped so a renamed group cannot linger collapsed', () => {
    expect(parseCollapsed(JSON.stringify(['home', 'ghost-group']))).toEqual(new Set(['home']));
  });
});

// ─── Search / palette ───────────────────────────────────────────────────────

describe('search', () => {
  test('subsequence matches scattered characters', () => {
    expect(subsequence('deliverables', 'dlv')).toBe(true);
    expect(subsequence('deliverables', 'zzz')).toBe(false);
    expect(subsequence('anything', '')).toBe(true);
  });

  test('an empty query returns every destination', () => {
    expect(searchDestinations('', 'en', AVAILABLE)).toHaveLength(35);
  });

  test('exact matches rank above prefix, substring and subsequence', () => {
    const hits = searchDestinations('clients', 'en', AVAILABLE);
    expect(hits[0]?.destinationId).toBe('clients');
    expect(hits[0]?.score).toBe(0);
  });

  test('matches Greek labels while the UI is in English', () => {
    const hits = searchDestinations('Πελάτες', 'en', AVAILABLE);
    expect(hits.map(h => h.destinationId)).toContain('clients');
    // The returned label is still in the ACTIVE locale.
    expect(hits.find(h => h.destinationId === 'clients')?.label).toBe('Clients');
  });

  test('matches English labels while the UI is in Greek', () => {
    const hits = searchDestinations('Deliverables', 'el', AVAILABLE);
    const hit = hits.find(h => h.destinationId === 'deliverables');
    expect(hit).toBeDefined();
    expect(hit?.label).toBe('Παραδοτέα');
  });

  test('a group name surfaces its destinations', () => {
    const hits = searchDestinations('Governance', 'en', AVAILABLE);
    expect(hits.map(h => h.destinationId)).toContain('quarantine');
  });

  test('unmapped destinations remain searchable — hiding them would misrepresent the product', () => {
    const hits = searchDestinations('Failed', 'en', AVAILABLE);
    const hit = hits.find(h => h.destinationId === 'integrations-failed');
    expect(hit).toBeDefined();
    expect(hit?.state.kind).toBe('unmapped');
  });

  test('a newly published destination is now actionable, not unmapped', () => {
    const hits = searchDestinations('quarantine', 'en', AVAILABLE);
    const hit = hits.find(h => h.destinationId === 'quarantine');
    expect(hit?.state.kind).toBe('ready');
  });

  test('search carries item state so the palette cannot offer a dead row', () => {
    for (const hit of searchDestinations('', 'en', OFFLINE)) {
      expect(hit.state.kind).not.toBe('ready');
    }
  });

  test('a non-matching query returns nothing', () => {
    expect(searchDestinations('zzzzqqqq', 'en', AVAILABLE)).toHaveLength(0);
  });

  test('Archon results are returned separately from Command Center results', () => {
    const hits = searchArchon('control', 'en');
    expect(hits.map(h => h.destinationId)).toContain('archon-control-plane');
    expect(hits.every(h => h.path.startsWith('/console') || h.path.startsWith('/legacy'))).toBe(
      true
    );
  });

  test('Archon search is bilingual too', () => {
    expect(searchArchon('Εκτελέσεις', 'el').map(h => h.destinationId)).toContain('archon-runs');
  });
});

describe('palette keyboard index', () => {
  test('wraps in both directions', () => {
    expect(clampIndex(3, 3)).toBe(0);
    expect(clampIndex(-1, 3)).toBe(2);
    expect(clampIndex(1, 3)).toBe(1);
  });

  test('an empty result set stays at zero rather than going negative', () => {
    expect(clampIndex(-1, 0)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });
});

// ─── Breadcrumbs ────────────────────────────────────────────────────────────

describe('breadcrumbs', () => {
  test('are Command Center › Group › Item', () => {
    const crumbs = breadcrumbsFor('clients', 'en', AVAILABLE);
    expect(crumbs.map(c => c.label)).toEqual(['Command Center', 'Agency', 'Clients']);
  });

  test('localize the group and item', () => {
    const crumbs = breadcrumbsFor('clients', 'el', AVAILABLE);
    expect(crumbs.map(c => c.label)).toEqual(['Command Center', 'Πρακτορείο', 'Πελάτες']);
  });

  test('the leaf links only when the destination is actionable', () => {
    expect(breadcrumbsFor('clients', 'en', AVAILABLE)[2]?.href).toBe(
      'http://127.0.0.1:8280/clients'
    );
    expect(breadcrumbsFor('clients', 'en', OFFLINE)[2]?.href).toBeUndefined();
    expect(breadcrumbsFor('integrations-failed', 'en', AVAILABLE)[2]?.href).toBeUndefined();
  });

  test('an unknown destination degrades to the root crumb instead of throwing', () => {
    expect(() => breadcrumbsFor('ghost', 'en', AVAILABLE)).not.toThrow();
    expect(breadcrumbsFor('ghost', 'en', AVAILABLE)).toEqual([{ label: 'Command Center' }]);
  });
});

// ─── Recents and favourites ─────────────────────────────────────────────────

describe('recents', () => {
  test('most recent first, de-duplicated', () => {
    let recents: string[] = [];
    recents = pushRecent(recents, 'clients');
    recents = pushRecent(recents, 'projects');
    recents = pushRecent(recents, 'clients');
    expect(recents).toEqual(['clients', 'projects']);
  });

  test('capped at MAX_RECENTS', () => {
    let recents: string[] = [];
    for (const d of allDestinations()) {
      recents = pushRecent(recents, d.id);
    }
    expect(recents).toHaveLength(MAX_RECENTS);
  });
});

describe('favourites', () => {
  test('toggle on and off', () => {
    const once = toggleFavourite([], 'clients');
    expect(once).toEqual(['clients']);
    expect(toggleFavourite(once, 'clients')).toEqual([]);
  });

  test('preserve insertion order', () => {
    expect(toggleFavourite(toggleFavourite([], 'team'), 'clients')).toEqual(['team', 'clients']);
  });
});

describe('stored id lists', () => {
  test('corrupt storage degrades to empty, never throws', () => {
    for (const raw of [null, '', 'not json', '{"a":1}', 'null', '[1,2,3]']) {
      expect(() => parseIdList(raw)).not.toThrow();
      expect(parseIdList(raw)).toEqual([]);
    }
  });

  test('ids that are no longer real destinations are dropped', () => {
    expect(parseIdList(JSON.stringify(['clients', 'removed-item']))).toEqual(['clients']);
  });

  test('resolveIds skips unknown ids rather than yielding holes', () => {
    const resolved = resolveIds(['clients', 'ghost', 'team']);
    expect(resolved.map(d => d.id)).toEqual(['clients', 'team']);
  });
});

// ─── Accessibility contract ─────────────────────────────────────────────────

/**
 * The shell has no DOM test environment, so these assert the invariants the
 * components depend on to be accessible: every control has a name in both
 * locales, every non-actionable state carries a machine-readable reason, and
 * nothing renders an empty accessible name.
 */
describe('accessibility contract', () => {
  test('every destination yields a non-empty accessible name in both locales', () => {
    for (const destination of allDestinations()) {
      expect(destination.labels.en.trim().length).toBeGreaterThan(0);
      expect(destination.labels.el.trim().length).toBeGreaterThan(0);
    }
  });

  test('every group yields a non-empty accessible name in both locales', () => {
    for (const group of NAVIGATION) {
      expect(group.labels.en.trim().length).toBeGreaterThan(0);
      expect(group.labels.el.trim().length).toBeGreaterThan(0);
    }
  });

  test('every non-actionable state supplies text a screen reader can announce', () => {
    for (const availability of [PROBING, OFFLINE, AVAILABLE]) {
      for (const destination of allDestinations()) {
        const state = itemState(destination, availability);
        if (state.kind === 'offline' || state.kind === 'unmapped') {
          expect(state.reason.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('an actionable item always has a real href — never "#" or empty', () => {
    for (const destination of allDestinations()) {
      const state = itemState(destination, AVAILABLE);
      if (state.kind === 'ready') {
        expect(state.href).toMatch(/^https?:\/\/.+/);
        expect(state.href).not.toContain('#');
      }
    }
  });

  test('breadcrumb labels are never empty, so aria-current has something to name', () => {
    for (const destination of allDestinations()) {
      for (const crumb of breadcrumbsFor(destination.id, 'el', AVAILABLE)) {
        expect(crumb.label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('search hits always carry both a label and a group label for the palette row', () => {
    for (const hit of searchDestinations('', 'el', AVAILABLE)) {
      expect(hit.label.trim().length).toBeGreaterThan(0);
      expect(hit.groupLabel.trim().length).toBeGreaterThan(0);
    }
  });
});
