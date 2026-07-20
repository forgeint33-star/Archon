/**
 * The Archon UX Navigation Bridge sidebar.
 *
 * A grouped, collapsible navigation shell over the GoViral Agency Command
 * Center, plus a terminal section for Archon's own screens so no Archon surface
 * is ever duplicated inside a Command Center group.
 *
 * Not mounted in the live console — see NavPreviewPage. Activation is a
 * separate, deliberate change.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { ChevronRight, CircleSlash, Loader2, Menu, Star, WifiOff, X } from 'lucide-react';
import {
  NAVIGATION,
  ARCHON_DESTINATIONS,
  destinationCapability,
  destinationLabels,
  type Destination,
  type Locale,
  type NavigationGroup,
} from './command-center-routes';
import {
  COMMAND_CENTER_BASE_URL,
  probeCommandCenter,
  PROBING,
  type Availability,
} from './command-center-health';
import {
  breadcrumbsFor,
  coverage,
  groupBadge,
  itemState,
  parseCollapsed,
  parseIdList,
  pushRecent,
  resolveIds,
  serializeCollapsed,
  toggleCollapsed,
  toggleFavourite,
  COLLAPSE_STORAGE_KEY,
  FAVOURITES_STORAGE_KEY,
  RECENTS_STORAGE_KEY,
  type Crumb,
  type ItemState,
} from './navigation-model';
import { CommandPalette } from './CommandPalette';

// ─── Copy ───────────────────────────────────────────────────────────────────

const COPY = {
  en: {
    nav: 'Command Center navigation',
    archon: 'Archon',
    archonNav: 'Archon navigation',
    probing: 'Checking Command Center…',
    offline: 'Command Center unavailable',
    unmapped: 'No route yet',
    search: 'Search…',
    openMenu: 'Open navigation',
    closeMenu: 'Close navigation',
    favourites: 'Favourites',
    recents: 'Recent',
    coverage: (m: number, t: number): string => `${String(m)} of ${String(t)} destinations linked`,
    skip: 'Skip to content',
    language: 'Ελληνικά',
  },
  el: {
    nav: 'Πλοήγηση Command Center',
    archon: 'Archon',
    archonNav: 'Πλοήγηση Archon',
    probing: 'Έλεγχος Command Center…',
    offline: 'Το Command Center δεν είναι διαθέσιμο',
    unmapped: 'Χωρίς διαδρομή ακόμη',
    search: 'Αναζήτηση…',
    openMenu: 'Άνοιγμα πλοήγησης',
    closeMenu: 'Κλείσιμο πλοήγησης',
    favourites: 'Αγαπημένα',
    recents: 'Πρόσφατα',
    coverage: (m: number, t: number): string =>
      `${String(m)} από ${String(t)} προορισμούς συνδεδεμένοι`,
    skip: 'Μετάβαση στο περιεχόμενο',
    language: 'English',
  },
} as const;

/**
 * A skip link must be the FIRST focusable element on the page. The bridge is
 * mounted after the project rail, so the link lives in the console shell rather
 * than here — this component only owns the wording.
 */
export const SKIP_LINK_COPY: Readonly<Record<Locale, string>> = {
  en: COPY.en.skip,
  el: COPY.el.skip,
};

// ─── Item ───────────────────────────────────────────────────────────────────

const ITEM_BASE =
  'group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors';

function StateIcon({ state }: { state: ItemState }): ReactElement | null {
  switch (state.kind) {
    case 'probing':
      return <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-text-tertiary" />;
    case 'offline':
      return <WifiOff aria-hidden className="h-3 w-3 shrink-0 text-warning" />;
    case 'unmapped':
      return <CircleSlash aria-hidden className="h-3 w-3 shrink-0 text-text-tertiary" />;
    case 'ready':
      return null;
  }
}

function NavItem({
  destination,
  state,
  locale,
  active,
  favourite,
  onActivate,
  onToggleFavourite,
}: {
  destination: Destination;
  state: ItemState;
  locale: Locale;
  active: boolean;
  favourite: boolean;
  onActivate: (id: string) => void;
  onToggleFavourite: (id: string) => void;
}): ReactElement {
  const copy = COPY[locale];
  // The manifest's own wording wins over the local fallback, so Archon never
  // shows a private translation that has drifted from the Command Center.
  const text = destinationLabels(destination)[locale];
  const capability = destinationCapability(destination);

  // The reason an item is not actionable is attached to the control itself, so
  // it is reachable by keyboard and screen reader rather than hover-only.
  const explanation =
    state.kind === 'unmapped'
      ? `${copy.unmapped}: ${state.reason}`
      : state.kind === 'offline'
        ? `${copy.offline}: ${state.reason}`
        : state.kind === 'probing'
          ? copy.probing
          : undefined;

  const favouriteButton = (
    <button
      type="button"
      onClick={(e): void => {
        e.preventDefault();
        e.stopPropagation();
        onToggleFavourite(destination.id);
      }}
      aria-pressed={favourite}
      aria-label={`${text} — ${copy.favourites}`}
      className="ml-auto shrink-0 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 aria-pressed:opacity-100"
    >
      <Star
        aria-hidden
        className={`h-3 w-3 ${favourite ? 'fill-accent text-accent' : 'text-text-tertiary'}`}
      />
    </button>
  );

  const body = (
    <>
      <destination.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{text}</span>
      <StateIcon state={state} />
      {favouriteButton}
    </>
  );

  if (state.kind === 'ready') {
    return (
      <a
        href={state.href}
        onClick={(): void => {
          onActivate(destination.id);
        }}
        aria-current={active ? 'page' : undefined}
        // Surfaced from the manifest so the capability the Command Center will
        // enforce is visible here rather than implied.
        data-capability={capability ?? undefined}
        title={capability ? `${text} — requires ${capability}` : text}
        className={`${ITEM_BASE} ${
          active
            ? 'bg-surface-elevated text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        }`}
      >
        {body}
      </a>
    );
  }

  // Not a link — an inert control. Rendering a disabled <a> without href keeps
  // it out of the tab order; a button with aria-disabled keeps it focusable so
  // the reason can be announced.
  return (
    <button
      type="button"
      aria-disabled="true"
      data-capability={capability ?? undefined}
      title={explanation}
      aria-describedby={undefined}
      onClick={(e): void => {
        e.preventDefault();
      }}
      className={`${ITEM_BASE} cursor-not-allowed text-text-tertiary`}
    >
      {body}
      <span className="sr-only">{explanation}</span>
    </button>
  );
}

// ─── Group ──────────────────────────────────────────────────────────────────

function Group({
  group,
  locale,
  availability,
  collapsed,
  activeId,
  favourites,
  onToggle,
  onActivate,
  onToggleFavourite,
}: {
  group: NavigationGroup;
  locale: Locale;
  availability: Availability;
  collapsed: boolean;
  activeId: string | null;
  favourites: readonly string[];
  onToggle: (id: string) => void;
  onActivate: (id: string) => void;
  onToggleFavourite: (id: string) => void;
}): ReactElement {
  const badge = groupBadge(group);
  const panelId = `nav-group-${group.id}`;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={(): void => {
          onToggle(group.id);
        }}
        aria-expanded={!collapsed}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
      >
        <ChevronRight
          aria-hidden
          className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        />
        <group.icon aria-hidden className="h-3 w-3 shrink-0" />
        <span className="truncate">{group.labels[locale]}</span>
        <span className="h-px flex-1 bg-border/60" />
        {/* Coverage, not a metric: "linked / total". Never presented as a health number. */}
        <span className="shrink-0 font-sans text-[10px] tabular-nums text-text-tertiary">
          {badge.mapped}/{badge.total}
        </span>
      </button>

      <div id={panelId} hidden={collapsed} className="mt-0.5 flex flex-col gap-0.5 pl-1.5">
        {group.destinations.map(destination => (
          <NavItem
            key={destination.id}
            destination={destination}
            state={itemState(destination, availability)}
            locale={locale}
            active={activeId === destination.id}
            favourite={favourites.includes(destination.id)}
            onActivate={onActivate}
            onToggleFavourite={onToggleFavourite}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Availability banner ────────────────────────────────────────────────────

function AvailabilityBanner({
  availability,
  locale,
}: {
  availability: Availability;
  locale: Locale;
}): ReactElement | null {
  const copy = COPY[locale];

  if (availability.kind === 'available') return null;

  if (availability.kind === 'probing') {
    return (
      <div
        role="status"
        className="mx-2.5 mb-2 flex items-center gap-2 rounded-[10px] border border-border bg-surface-inset px-2.5 py-2 text-[11px] text-text-tertiary"
      >
        <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" />
        {copy.probing}
      </div>
    );
  }

  // Exactly one honest unavailable state, carrying the real reason. No fake
  // zeros, no broken links — every Command Center item is inert above.
  return (
    <div
      role="status"
      className="mx-2.5 mb-2 rounded-[10px] border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning"
    >
      <p className="flex items-center gap-2 font-medium">
        <WifiOff aria-hidden className="h-3 w-3 shrink-0" />
        {copy.offline}
      </p>
      <p className="mt-1 text-warning/80">{availability.reason}</p>
      <p className="mt-1 break-all text-warning/60">{COMMAND_CENTER_BASE_URL}</p>
    </div>
  );
}

// ─── Breadcrumbs ────────────────────────────────────────────────────────────

export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }): ReactElement {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${String(i)}`} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden>/</span> : null}
              {crumb.href && !last ? (
                <a href={crumb.href} className="hover:text-text-secondary">
                  {crumb.label}
                </a>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'text-text-secondary' : ''}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─── Sidebar body ───────────────────────────────────────────────────────────

function SidebarBody({
  locale,
  availability,
  collapsed,
  activeId,
  favourites,
  recents,
  onToggleGroup,
  onActivate,
  onToggleFavourite,
  onOpenPalette,
  onToggleLocale,
}: {
  locale: Locale;
  availability: Availability;
  collapsed: ReadonlySet<string>;
  activeId: string | null;
  favourites: readonly string[];
  recents: readonly string[];
  onToggleGroup: (id: string) => void;
  onActivate: (id: string) => void;
  onToggleFavourite: (id: string) => void;
  onOpenPalette: () => void;
  onToggleLocale: () => void;
}): ReactElement {
  const copy = COPY[locale];
  const cover = coverage();
  const favouriteItems = resolveIds(favourites);
  const recentItems = resolveIds(recents);

  return (
    <div className="flex h-full flex-col">
      <div className="px-2.5 py-3">
        <button
          type="button"
          onClick={onOpenPalette}
          className="flex w-full items-center gap-2 rounded-[10px] border border-border bg-surface-inset px-2.5 py-1.5 text-left text-[12px] text-text-tertiary transition-colors hover:border-border-bright hover:text-text-secondary"
        >
          <span aria-hidden>⌕</span>
          <span className="truncate">{copy.search}</span>
          <kbd className="ml-auto shrink-0 rounded border border-border px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>
      </div>

      <AvailabilityBanner availability={availability} locale={locale} />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {favouriteItems.length > 0 ? (
          <QuickList
            title={copy.favourites}
            items={favouriteItems}
            locale={locale}
            availability={availability}
            activeId={activeId}
            favourites={favourites}
            onActivate={onActivate}
            onToggleFavourite={onToggleFavourite}
          />
        ) : null}

        {recentItems.length > 0 ? (
          <QuickList
            title={copy.recents}
            items={recentItems}
            locale={locale}
            availability={availability}
            activeId={activeId}
            favourites={favourites}
            onActivate={onActivate}
            onToggleFavourite={onToggleFavourite}
          />
        ) : null}

        <nav aria-label={copy.nav}>
          {NAVIGATION.map(group => (
            <Group
              key={group.id}
              group={group}
              locale={locale}
              availability={availability}
              collapsed={collapsed.has(group.id)}
              activeId={activeId}
              favourites={favourites}
              onToggle={onToggleGroup}
              onActivate={onActivate}
              onToggleFavourite={onToggleFavourite}
            />
          ))}
        </nav>

        {/* Archon's own screens, deliberately separate from every Command
            Center group so no business screen is duplicated inside Archon. */}
        <nav aria-label={copy.archonNav} className="mt-3 border-t border-border pt-3">
          <p className="px-2.5 pb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-tertiary">
            {copy.archon}
          </p>
          <div className="flex flex-col gap-0.5">
            {ARCHON_DESTINATIONS.map(destination => {
              return (
                <Link
                  key={destination.id}
                  to={destination.path}
                  className={`${ITEM_BASE} text-text-secondary hover:bg-surface-hover hover:text-text-primary`}
                >
                  <destination.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{destination.labels[locale]}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>

      <div className="flex items-center justify-between border-t border-border px-2.5 py-2">
        <span className="text-[10px] text-text-tertiary">
          {copy.coverage(cover.mapped, cover.total)}
        </span>
        <button
          type="button"
          onClick={onToggleLocale}
          lang={locale === 'en' ? 'el' : 'en'}
          className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-surface-hover"
        >
          {copy.language}
        </button>
      </div>
    </div>
  );
}

function QuickList({
  title,
  items,
  locale,
  availability,
  activeId,
  favourites,
  onActivate,
  onToggleFavourite,
}: {
  title: string;
  items: readonly Destination[];
  locale: Locale;
  availability: Availability;
  activeId: string | null;
  favourites: readonly string[];
  onActivate: (id: string) => void;
  onToggleFavourite: (id: string) => void;
}): ReactElement {
  return (
    <nav aria-label={title} className="mb-2">
      <p className="px-2.5 pb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-tertiary">
        {title}
      </p>
      <div className="flex flex-col gap-0.5">
        {items.map(destination => (
          <NavItem
            key={destination.id}
            destination={destination}
            state={itemState(destination, availability)}
            locale={locale}
            active={activeId === destination.id}
            favourite={favourites.includes(destination.id)}
            onActivate={onActivate}
            onToggleFavourite={onToggleFavourite}
          />
        ))}
      </div>
    </nav>
  );
}

// ─── Bridge ─────────────────────────────────────────────────────────────────

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode or a blocked origin must not break navigation.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preference persistence is best-effort; navigation still works without it.
  }
}

export function NavigationBridge(): ReactElement {
  const [locale, setLocale] = useState<Locale>('en');
  const [availability, setAvailability] = useState<Availability>(PROBING);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    parseCollapsed(readStorage(COLLAPSE_STORAGE_KEY))
  );
  const [favourites, setFavourites] = useState<readonly string[]>(() =>
    parseIdList(readStorage(FAVOURITES_STORAGE_KEY))
  );
  const [recents, setRecents] = useState<readonly string[]>(() =>
    parseIdList(readStorage(RECENTS_STORAGE_KEY))
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect((): (() => void) => {
    let cancelled = false;

    void probeCommandCenter().then((result): void => {
      if (!cancelled) setAvailability(result);
    });

    return (): void => {
      cancelled = true;
    };
  }, []);

  // keymap.ts deliberately drops modifier chords (lib/keymap.ts:126-129), so
  // ⌘K/Ctrl+K needs its own listener, modelled on useBuilderKeyboard.
  useEffect((): (() => void) => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(open => !open);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const onToggleGroup = useCallback((groupId: string): void => {
    setCollapsed(prev => {
      const next = toggleCollapsed(prev, groupId);
      writeStorage(COLLAPSE_STORAGE_KEY, serializeCollapsed(next));
      return next;
    });
  }, []);

  const onActivate = useCallback((destinationId: string): void => {
    setActiveId(destinationId);
    setMobileOpen(false);
    setRecents(prev => {
      const next = pushRecent(prev, destinationId);
      writeStorage(RECENTS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const onToggleFavourite = useCallback((destinationId: string): void => {
    setFavourites(prev => {
      const next = toggleFavourite(prev, destinationId);
      writeStorage(FAVOURITES_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const onToggleLocale = useCallback((): void => {
    setLocale(prev => (prev === 'en' ? 'el' : 'en'));
  }, []);

  const crumbs = useMemo(
    (): Crumb[] => (activeId ? breadcrumbsFor(activeId, locale, availability) : []),
    [activeId, locale, availability]
  );

  const copy = COPY[locale];

  const body = (
    <SidebarBody
      locale={locale}
      availability={availability}
      collapsed={collapsed}
      activeId={activeId}
      favourites={favourites}
      recents={recents}
      onToggleGroup={onToggleGroup}
      onActivate={onActivate}
      onToggleFavourite={onToggleFavourite}
      onOpenPalette={(): void => {
        setPaletteOpen(true);
      }}
      onToggleLocale={onToggleLocale}
    />
  );

  return (
    <>
      {/* Tablet/mobile trigger. Hidden from desktop, where the rail is persistent. */}
      <button
        type="button"
        onClick={(): void => {
          setMobileOpen(true);
        }}
        aria-label={copy.openMenu}
        aria-expanded={mobileOpen}
        className="fixed left-3 top-3 z-30 rounded-[10px] border border-border bg-surface-elevated p-2 text-text-secondary lg:hidden"
      >
        <Menu aria-hidden className="h-4 w-4" />
      </button>

      {/* Desktop rail */}
      <div className="hidden h-full w-[280px] shrink-0 border-r border-border bg-surface-inset lg:block">
        {body}
      </div>

      {/* Mobile drawer. role=dialog + aria-modal are required by keymap.ts's
          modalIsOpen() scan, or page shortcuts leak through the overlay. */}
      {mobileOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={copy.nav}
          className="fixed inset-0 z-40 flex lg:hidden"
        >
          <div
            className="absolute inset-0 bg-black/60"
            onClick={(): void => {
              setMobileOpen(false);
            }}
            aria-hidden
          />
          <div className="relative flex h-full w-[85vw] max-w-[320px] flex-col border-r border-border bg-surface-inset">
            <button
              type="button"
              onClick={(): void => {
                setMobileOpen(false);
              }}
              aria-label={copy.closeMenu}
              className="absolute right-2 top-2 z-10 rounded p-1 text-text-secondary"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
            {body}
          </div>
        </div>
      ) : null}

      <CommandPalette
        open={paletteOpen}
        locale={locale}
        availability={availability}
        onClose={(): void => {
          setPaletteOpen(false);
        }}
        onActivate={onActivate}
      />

      {crumbs.length > 0 ? (
        <div className="sr-only" id="nav-bridge-crumbs">
          <Breadcrumbs crumbs={crumbs} />
        </div>
      ) : null}
    </>
  );
}
