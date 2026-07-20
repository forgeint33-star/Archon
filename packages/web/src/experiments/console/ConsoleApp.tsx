import { lazy, Suspense, useMemo, useState, type ReactElement } from 'react';
import { Routes, Route, useNavigate } from 'react-router';
import { ProjectRail } from './components/ProjectRail';
import { AddProjectDialog } from './components/AddProjectDialog';
import { ProjectPalette } from './components/ProjectPalette';
import { KeymapHelp } from './components/KeymapHelp';
import { BuilderRoute } from './builder/BuilderRoute';
import { RunsPage } from './routes/RunsPage';
import { RunDetailPage } from './routes/RunDetailPage';
import { ChatPage } from './routes/ChatPage';
import { PreviewPage } from './routes/PreviewPage';
import { SettingsPage } from './routes/SettingsPage';
import { NavPreviewPage } from './navigation/NavPreviewPage';
import { NavigationBridge, SKIP_LINK_COPY } from './navigation/NavigationBridge';

/**
 * The bridge preview harness ships only in dev builds, or when a build
 * explicitly opts in for browser testing. `import.meta.env.DEV` is statically
 * false in a production bundle, so the route and its component are dropped.
 */
const NAV_PREVIEW_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_NAV_PREVIEW === 'true';

// React.lazy components must be PascalCase for JSX usage
// eslint-disable-next-line @typescript-eslint/naming-convention
const LazyGoviralControlPlanePage = lazy(() =>
  import('./routes/GoviralControlPlanePage').then(m => ({ default: m.GoviralControlPlanePage }))
);
import { invalidate } from './store/cache';
import { K } from './store/keys';
import { useKeymap, type Binding } from './lib/keymap';
import { SHORTCUTS } from './lib/shortcuts';
import './theme.css';

/**
 * Console experiment shell.
 *
 * Mounted at `/console/*` outside the production <Layout /> so the existing
 * TopNav does not render over us. Internal <Routes> handle console-specific
 * paths relative to /console.
 */
export function ConsoleApp(): ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();

  // `n` (new run) is owned by DraftRunCard's own window listener — only
  // mounted when a project is scoped — and stays there.
  const globalBindings = useMemo<readonly Binding[]>(
    () => [
      {
        keys: ['p'],
        label: 'Pick a project',
        run: (): void => {
          setPaletteOpen(true);
        },
      },
      {
        keys: ['?'],
        label: 'Show help',
        run: (): void => {
          setHelpOpen(v => !v);
        },
      },
      {
        keys: [','],
        label: 'Open settings',
        run: (): void => {
          navigate('/console/settings');
        },
      },
    ],
    [navigate]
  );
  useKeymap({
    bindings: globalBindings,
    enabled: !addOpen && !paletteOpen && !helpOpen,
  });

  return (
    <div className="console-root flex h-screen w-screen flex-col bg-surface text-text-primary">
      {/* Must be the first focusable element in the document, so it lives here
          rather than inside the navigation bridge (which mounts after the
          project rail and would therefore never receive the first Tab). */}
      <a
        href="#nav-bridge-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface-elevated focus:px-3 focus:py-2 focus:text-text-primary"
      >
        {SKIP_LINK_COPY.en}
      </a>
      <div className="flex min-h-0 flex-1">
        <ProjectRail
          onAddProject={() => {
            setAddOpen(true);
          }}
        />
        {/* Agency Command Center navigation. Kept as its own column beside the
            project rail: the rail switches Archon projects, the bridge reaches
            Agency screens, and the bridge carries its own terminal Archon
            section so no Agency group ever contains an Archon screen. */}
        <NavigationBridge />
        <main id="nav-bridge-content" className="flex min-w-0 flex-1 flex-col">
          <Routes>
            <Route index element={<RunsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="builder" element={<BuilderRoute />} />
            <Route
              path="goviral"
              element={
                <Suspense
                  fallback={
                    <div className="p-8 text-center text-sm text-white/50">
                      Loading Control Plane…
                    </div>
                  }
                >
                  <LazyGoviralControlPlanePage />
                </Suspense>
              }
            />
            <Route path="_preview" element={<PreviewPage />} />
            {/* The navigation-bridge harness is named by the Command Center
                manifest as `excluded_non_production`. It is registered only in
                dev/test builds — a production bundle has no such route, so it
                cannot be reached on a released install. The bridge itself is
                mounted for real in the rail below. */}
            {NAV_PREVIEW_ENABLED ? (
              <Route path="_nav-preview" element={<NavPreviewPage />} />
            ) : null}
            <Route path="p/:projectId" element={<RunsPage />} />
            <Route path="p/:projectId/chat" element={<ChatPage />} />
            <Route path="p/:projectId/r/:runId" element={<RunDetailPage />} />
          </Routes>
        </main>
      </div>

      <AddProjectDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
        }}
        onAdded={project => {
          invalidate(K.projects);
          navigate(`/console/p/${project.id}`);
        }}
      />

      <ProjectPalette
        open={paletteOpen}
        onClose={() => {
          setPaletteOpen(false);
        }}
      />

      <KeymapHelp
        open={helpOpen}
        onClose={() => {
          setHelpOpen(false);
        }}
        groups={SHORTCUTS}
      />
    </div>
  );
}
