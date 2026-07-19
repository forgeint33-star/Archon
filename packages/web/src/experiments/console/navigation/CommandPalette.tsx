/**
 * Global command palette for the navigation bridge.
 *
 * Deliberately hand-rolled on the same combobox/listbox shape as
 * components/ProjectPalette.tsx rather than pulling in cmdk — the console has
 * no cmdk dependency and one palette idiom across the shell is worth more than
 * a second library.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { CircleSlash, Loader2, WifiOff, type LucideIcon } from 'lucide-react';
import { findDestination, type Locale } from './command-center-routes';
import type { Availability } from './command-center-health';
import { clampIndex, searchArchon, searchDestinations, type ItemState } from './navigation-model';

const COPY = {
  en: {
    title: 'Search destinations',
    placeholder: 'Search Command Center and Archon…',
    commandCenter: 'Command Center',
    archon: 'Archon',
    empty: 'No destinations match.',
    hint: '↑↓ move · ↵ open · esc cancel',
    noRoute: 'no route yet',
    offline: 'unavailable',
    probing: 'checking…',
  },
  el: {
    title: 'Αναζήτηση προορισμών',
    placeholder: 'Αναζήτηση σε Command Center και Archon…',
    commandCenter: 'Command Center',
    archon: 'Archon',
    empty: 'Κανένας προορισμός δεν ταιριάζει.',
    hint: '↑↓ μετακίνηση · ↵ άνοιγμα · esc ακύρωση',
    noRoute: 'χωρίς διαδρομή',
    offline: 'μη διαθέσιμο',
    probing: 'έλεγχος…',
  },
} as const;

interface Row {
  key: string;
  label: string;
  context: string;
  /** Command Center rows carry a state; Archon rows are always navigable. */
  state: ItemState | null;
  destinationId: string | null;
  path: string | null;
}

function stateSuffix(state: ItemState | null, locale: Locale): string | null {
  if (!state) return null;
  switch (state.kind) {
    case 'unmapped':
      return COPY[locale].noRoute;
    case 'offline':
      return COPY[locale].offline;
    case 'probing':
      return COPY[locale].probing;
    case 'ready':
      return null;
  }
}

function StateGlyph({ state }: { state: ItemState | null }): ReactElement | null {
  if (!state) return null;
  switch (state.kind) {
    case 'probing':
      return <Loader2 aria-hidden className="h-3 w-3 animate-spin text-text-tertiary" />;
    case 'offline':
      return <WifiOff aria-hidden className="h-3 w-3 text-warning" />;
    case 'unmapped':
      return <CircleSlash aria-hidden className="h-3 w-3 text-text-tertiary" />;
    case 'ready':
      return null;
  }
}

export function CommandPalette({
  open,
  locale,
  availability,
  onClose,
  onActivate,
}: {
  open: boolean;
  locale: Locale;
  availability: Availability;
  onClose: () => void;
  onActivate: (destinationId: string) => void;
}): ReactElement | null {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const copy = COPY[locale];

  const rows = useMemo((): Row[] => {
    const commandCenter = searchDestinations(query, locale, availability).map(
      (hit): Row => ({
        key: `cc-${hit.destinationId}`,
        label: hit.label,
        context: `${copy.commandCenter} · ${hit.groupLabel}`,
        state: hit.state,
        destinationId: hit.destinationId,
        path: null,
      })
    );

    const archon = searchArchon(query, locale).map(
      (hit): Row => ({
        key: `archon-${hit.destinationId}`,
        label: hit.label,
        context: copy.archon,
        state: null,
        destinationId: null,
        path: hit.path,
      })
    );

    return [...commandCenter, ...archon];
  }, [query, locale, availability, copy.commandCenter, copy.archon]);

  useEffect((): void => {
    if (open) {
      setQuery('');
      setIndex(0);
      // Synchronous focus, matching ProjectPalette — deferring leaks a frame of
      // page-level key handling into the overlay.
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect((): void => {
    setIndex(prev => clampIndex(prev, rows.length));
  }, [rows.length]);

  const activate = useCallback(
    (row: Row | undefined): void => {
      if (!row) return;

      if (row.path !== null) {
        navigate(row.path);
        onClose();
        return;
      }

      if (row.destinationId === null) return;

      // Only a ready destination navigates. An unmapped or offline row stays
      // selectable and readable, but must not pretend to lead somewhere.
      if (row.state?.kind === 'ready') {
        onActivate(row.destinationId);
        const destination = findDestination(row.destinationId);
        if (destination?.binding.kind === 'mapped') {
          window.location.assign(row.state.href);
        }
        onClose();
      }
    },
    [navigate, onActivate, onClose]
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex(prev => clampIndex(prev + 1, rows.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex(prev => clampIndex(prev - 1, rows.length));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        activate(rows[index]);
      }
    },
    [rows, index, activate, onClose]
  );

  if (!open) return null;

  const activeId = rows[index] ? `nav-palette-row-${rows[index].key}` : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
    >
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-xl overflow-hidden rounded-[14px] border border-border bg-surface-elevated shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e): void => {
            setQuery(e.target.value);
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="nav-palette-listbox"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label={copy.title}
          placeholder={copy.placeholder}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
        />

        <ul
          id="nav-palette-listbox"
          role="listbox"
          aria-label={copy.title}
          className="max-h-[46vh] overflow-y-auto py-1"
        >
          {rows.map((row, i) => {
            const suffix = stateSuffix(row.state, locale);
            const selected = i === index;
            const actionable = row.path !== null || row.state?.kind === 'ready';

            return (
              <li key={row.key}>
                <button
                  type="button"
                  id={`nav-palette-row-${row.key}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={actionable ? undefined : true}
                  onClick={(): void => {
                    activate(row);
                  }}
                  onMouseEnter={(): void => {
                    setIndex(i);
                  }}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] ${
                    selected ? 'bg-surface-hover' : ''
                  } ${actionable ? 'text-text-primary' : 'text-text-tertiary'}`}
                >
                  <span className="truncate">{row.label}</span>
                  <StateGlyph state={row.state} />
                  {suffix ? (
                    <span className="shrink-0 text-[10px] text-text-tertiary">({suffix})</span>
                  ) : null}
                  <span className="ml-auto shrink-0 truncate text-[10.5px] text-text-tertiary">
                    {row.context}
                  </span>
                </button>
              </li>
            );
          })}

          {rows.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-text-tertiary">{copy.empty}</li>
          ) : null}
        </ul>

        <p className="border-t border-border px-4 py-2 text-[10.5px] text-text-tertiary">
          {copy.hint}
        </p>
      </div>
    </div>
  );
}

/** Re-exported so the preview harness can render an icon column without
 *  reaching into lucide directly. */
export type { LucideIcon };
