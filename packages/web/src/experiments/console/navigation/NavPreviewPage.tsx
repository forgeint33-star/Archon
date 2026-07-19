/**
 * Isolated preview harness for the navigation bridge.
 *
 * Mounted at the unlinked `/console/_nav-preview` path — the `_` prefix marks
 * it as a harness, matching the existing `_preview` route. It exists so the
 * shell can be exercised in a real browser (keyboard traversal, palette,
 * breakpoints, the unavailable state) without replacing the live ProjectRail.
 *
 * This is NOT activation. Nothing links here, and the console's real navigation
 * is untouched. Mounting the bridge for real is a separate, deliberate change
 * that must follow the route-gap decision recorded in
 * ops/goviral-control-plane/PRD-ARCHON-UX-NAVIGATION-BRIDGE.md.
 */

import { type ReactElement } from 'react';
import { NavigationBridge } from './NavigationBridge';
import { coverage } from './navigation-model';
import { COMMAND_CENTER_BASE_URL } from './command-center-health';

export function NavPreviewPage(): ReactElement {
  const cover = coverage();

  return (
    <div className="flex h-full min-h-0">
      <NavigationBridge />

      <main id="nav-bridge-content" className="min-w-0 flex-1 overflow-y-auto p-6 lg:p-8">
        <h1 className="text-xl font-semibold text-text-primary">
          Navigation Bridge — preview harness
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-text-secondary">
          Isolated preview of the Archon UX Navigation Bridge. Not mounted in the live console and
          not linked from anywhere.
        </p>

        <dl className="mt-6 grid max-w-2xl gap-3 sm:grid-cols-2">
          <div className="rounded-[10px] border border-border bg-surface-inset p-4">
            <dt className="text-xs uppercase tracking-wide text-text-tertiary">
              Command Center base URL
            </dt>
            <dd className="mt-1 break-all font-mono text-xs text-text-secondary">
              {COMMAND_CENTER_BASE_URL}
            </dd>
          </div>
          <div className="rounded-[10px] border border-border bg-surface-inset p-4">
            <dt className="text-xs uppercase tracking-wide text-text-tertiary">Route coverage</dt>
            <dd className="mt-1 text-sm text-text-secondary">
              {cover.mapped} of {cover.total} destinations bound to an approved route;{' '}
              {cover.unmapped} awaiting an upstream route decision.
            </dd>
          </div>
        </dl>

        <p className="mt-6 max-w-2xl text-xs text-text-tertiary">
          Destinations without an approved Command Center route render as inert, with the reason
          attached. They are never links, and their absence is never shown as a measured zero.
        </p>
      </main>
    </div>
  );
}
