/**
 * Pure view-model for the navigation bridge.
 *
 * All navigation behaviour that can be decided without a DOM lives here —
 * item state, search, breadcrumbs, recents and favourites, group collapse.
 * The web package has no DOM test environment by design, so keeping this layer
 * pure is what makes the shell testable at all.
 */

import {
  NAVIGATION,
  ARCHON_DESTINATIONS,
  allDestinations,
  findGroupOf,
  type ArchonDestination,
  type Destination,
  type Locale,
  type NavigationGroup,
} from './command-center-routes';
import { destinationUrl, linksEnabled, type Availability } from './command-center-health';

// ─── Item state ─────────────────────────────────────────────────────────────

/**
 * Why an item is not actionable. Three distinct causes that must never be
 * collapsed into one generic "disabled" — the operator needs to know whether
 * to wait, to configure, or to escalate a missing contract.
 */
export type ItemState =
  /** Approved route + Command Center reachable. */
  | { kind: 'ready'; href: string }
  /** Approved route, but the probe has not resolved yet. */
  | { kind: 'probing' }
  /** Approved route, but the Command Center is not reachable. */
  | { kind: 'offline'; reason: string }
  /** No approved route exists upstream. Not a failure — an unfilled contract. */
  | { kind: 'unmapped'; reason: string };

export function itemState(destination: Destination, availability: Availability): ItemState {
  if (destination.binding.kind === 'unmapped') {
    return { kind: 'unmapped', reason: destination.binding.reason };
  }

  if (availability.kind === 'probing') {
    return { kind: 'probing' };
  }

  if (!linksEnabled(availability)) {
    const reason =
      availability.kind === 'unavailable' ? availability.reason : 'Command Center unavailable';
    return { kind: 'offline', reason };
  }

  return { kind: 'ready', href: destinationUrl(destination.binding.route) };
}

export function isActionable(state: ItemState): boolean {
  return state.kind === 'ready';
}

// ─── Group badges ───────────────────────────────────────────────────────────

export interface GroupBadge {
  /** Destinations in this group with an approved route. */
  mapped: number;
  /** Destinations awaiting an upstream route decision. */
  unmapped: number;
  total: number;
}

export function groupBadge(group: NavigationGroup): GroupBadge {
  const mapped = group.destinations.filter(d => d.binding.kind === 'mapped').length;
  return {
    mapped,
    unmapped: group.destinations.length - mapped,
    total: group.destinations.length,
  };
}

/** Whole-bridge coverage, surfaced so the contract gap is visible, not buried. */
export function coverage(): GroupBadge {
  const all = allDestinations();
  const mapped = all.filter(d => d.binding.kind === 'mapped').length;
  return { mapped, unmapped: all.length - mapped, total: all.length };
}

// ─── Group collapse ─────────────────────────────────────────────────────────

export const COLLAPSE_STORAGE_KEY = 'archon.console.nav.collapsed';

/**
 * Collapsed-group ids. Parsing is defensive: a corrupt or hand-edited value
 * must degrade to "nothing collapsed", never throw during render.
 */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const known = new Set(NAVIGATION.map(g => g.id));
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && known.has(id)));
  } catch {
    return new Set();
  }
}

export function serializeCollapsed(collapsed: ReadonlySet<string>): string {
  return JSON.stringify([...collapsed].sort());
}

export function toggleCollapsed(collapsed: ReadonlySet<string>, groupId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(groupId)) {
    next.delete(groupId);
  } else {
    next.add(groupId);
  }
  return next;
}

// ─── Search / command palette ───────────────────────────────────────────────

export interface SearchHit {
  destinationId: string;
  groupId: string;
  /** The label that matched, in the active locale. */
  label: string;
  groupLabel: string;
  state: ItemState;
  /** Lower is better. */
  score: number;
}

/**
 * Subsequence match, mirroring ProjectPalette's existing matcher so palette
 * behaviour stays consistent across the console.
 */
export function subsequence(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

function scoreLabel(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (q.length === 0) return 2;
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (l.includes(q)) return 2;
  if (subsequence(l, q)) return 3;
  return null;
}

/**
 * Searches both locales regardless of the active one, so a Greek operator can
 * type an English label and vice versa. Unmapped destinations are still
 * returned — hiding them would silently misrepresent what the product has.
 */
export function searchDestinations(
  query: string,
  locale: Locale,
  availability: Availability
): SearchHit[] {
  const trimmed = query.trim();
  const hits: SearchHit[] = [];

  for (const group of NAVIGATION) {
    for (const destination of group.destinations) {
      const scores = [
        scoreLabel(destination.labels.en, trimmed),
        scoreLabel(destination.labels.el, trimmed),
        scoreLabel(group.labels.en, trimmed),
        scoreLabel(group.labels.el, trimmed),
      ].filter((s): s is number => s !== null);

      if (scores.length === 0) continue;

      hits.push({
        destinationId: destination.id,
        groupId: group.id,
        label: destination.labels[locale],
        groupLabel: group.labels[locale],
        state: itemState(destination, availability),
        score: Math.min(...scores),
      });
    }
  }

  return hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

export interface ArchonHit {
  destinationId: string;
  label: string;
  path: string;
  score: number;
}

/** Archon's own screens are searchable too, but reported separately so the
 *  palette can label their origin and never imply they are Command Center
 *  destinations. */
export function searchArchon(query: string, locale: Locale): ArchonHit[] {
  const trimmed = query.trim();

  return ARCHON_DESTINATIONS.map((destination: ArchonDestination): ArchonHit | null => {
    const scores = [
      scoreLabel(destination.labels.en, trimmed),
      scoreLabel(destination.labels.el, trimmed),
    ].filter((s): s is number => s !== null);

    return scores.length === 0
      ? null
      : {
          destinationId: destination.id,
          label: destination.labels[locale],
          path: destination.path,
          score: Math.min(...scores),
        };
  })
    .filter((hit): hit is ArchonHit => hit !== null)
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

/** Keeps the highlighted palette row inside bounds as the result set changes. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return length - 1;
  if (index >= length) return 0;
  return index;
}

// ─── Breadcrumbs ────────────────────────────────────────────────────────────

export interface Crumb {
  label: string;
  /** Present only when the crumb is itself navigable. */
  href?: string;
}

/**
 * Breadcrumbs for a Command Center destination: Command Center › Group › Item.
 * The leaf carries an href only when the item is actionable, so a breadcrumb
 * can never become a broken link either.
 */
export function breadcrumbsFor(
  destinationId: string,
  locale: Locale,
  availability: Availability
): Crumb[] {
  const group = findGroupOf(destinationId);
  const destination = group?.destinations.find(d => d.id === destinationId);

  if (!group || !destination) {
    return [{ label: 'Command Center' }];
  }

  const state = itemState(destination, availability);

  return [
    { label: 'Command Center' },
    { label: group.labels[locale] },
    {
      label: destination.labels[locale],
      ...(state.kind === 'ready' ? { href: state.href } : {}),
    },
  ];
}

// ─── Recents and favourites ─────────────────────────────────────────────────

export const RECENTS_STORAGE_KEY = 'archon.console.nav.recents';
export const FAVOURITES_STORAGE_KEY = 'archon.console.nav.favourites';
export const MAX_RECENTS = 6;

/** Parses a stored id list, dropping anything that is no longer a real
 *  destination so a renamed or removed item cannot resurrect as a dead entry. */
export function parseIdList(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const known = new Set(allDestinations().map(d => d.id));
    return parsed.filter((id): id is string => typeof id === 'string' && known.has(id));
  } catch {
    return [];
  }
}

/** Most-recent-first, de-duplicated, capped. */
export function pushRecent(recents: readonly string[], destinationId: string): string[] {
  return [destinationId, ...recents.filter(id => id !== destinationId)].slice(0, MAX_RECENTS);
}

export function toggleFavourite(favourites: readonly string[], destinationId: string): string[] {
  return favourites.includes(destinationId)
    ? favourites.filter(id => id !== destinationId)
    : [...favourites, destinationId];
}

export function resolveIds(ids: readonly string[]): Destination[] {
  const byId = new Map(allDestinations().map(d => [d.id, d]));
  return ids.map(id => byId.get(id)).filter((d): d is Destination => d !== undefined);
}
