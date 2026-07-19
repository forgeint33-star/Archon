/**
 * Route contract between Archon's navigation bridge and the GoViral Agency
 * Command Center.
 *
 * SOURCE OF TRUTH — the Command Center's approved PRD, Information Architecture
 * and Screen Map section:
 *
 *   .planning/prds/draft/2026-07-19-goviral-agency-command-center-v1.md:176-224
 *   approved by .governance/approvals/2026-07-19-agency-command-center-approval.md
 *   (commit 51a4e97)
 *
 * That PRD is committed and approved; its router is NOT yet implemented and its
 * branch is not pushed to any remote. This module therefore binds to the
 * approved IA only, and deliberately ignores the in-progress implementation.
 *
 * Two rules hold here, and the contract test enforces both:
 *
 *  1. `COMMAND_CENTER_ROUTES` is a verbatim transcription of the approved 43
 *     routes. Nothing may be added to it that the PRD does not define.
 *  2. A navigation destination may only be `mapped` to a path that appears in
 *     that list. Destinations with no approved route are `unmapped` and carry
 *     the reason — they render as pending, never as a link.
 *
 * Inventing a path to fill a gap is precisely the failure the Control Plane
 * contract hotfix removed: a frontend asserting a contract the other side never
 * agreed to. Do not do it here.
 */

import {
  Activity,
  AlertTriangle,
  Archive,
  BadgeCheck,
  Bell,
  Bot,
  Boxes,
  Brain,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Cpu,
  CreditCard,
  FileStack,
  FolderKanban,
  Gauge,
  GitPullRequest,
  Home,
  Image,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  Plug,
  PlugZap,
  Rocket,
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

// ─── The approved route list ────────────────────────────────────────────────

/** PRD area letters A–N. */
export type CommandCenterArea =
  | 'A' // Executive Dashboard
  | 'B' // CRM
  | 'C' // Projects and Production
  | 'D' // Live Workflow and Agent Ops
  | 'E' // Quality and Review
  | 'F' // Approval Center
  | 'G' // Revisions and Deliverables
  | 'H' // Client Asset Library
  | 'I' // Integrations Center
  | 'J' // Costs
  | 'K' // Publishing and Deployment
  | 'L' // Communications
  | 'M' // Team and Access
  | 'N'; // Audit and Incidents

export interface CommandCenterRoute {
  path: string;
  area: CommandCenterArea;
  /** True when the path contains a `:param` and cannot be a top-level nav target. */
  parameterized: boolean;
}

const route = (path: string, area: CommandCenterArea): CommandCenterRoute => ({
  path,
  area,
  parameterized: path.includes(':'),
});

/** All 43 approved routes, verbatim from PRD:176-224. */
export const COMMAND_CENTER_ROUTES: readonly CommandCenterRoute[] = [
  // A. Executive Dashboard (2)
  route('/', 'A'),
  route('/health', 'A'),
  // B. CRM (5)
  route('/clients', 'B'),
  route('/clients/new', 'B'),
  route('/clients/:id', 'B'),
  route('/clients/:id/contacts', 'B'),
  route('/clients/:id/contracts', 'B'),
  // C. Projects and Production (6)
  route('/projects', 'C'),
  route('/projects/new', 'C'),
  route('/projects/:id', 'C'),
  route('/projects/:id/board', 'C'),
  route('/projects/:id/timeline', 'C'),
  route('/templates', 'C'),
  // D. Live Workflow and Agent Ops (5)
  route('/runs', 'D'),
  route('/runs/:id', 'D'),
  route('/runs/:id/events', 'D'),
  route('/runs/:id/outputs', 'D'),
  route('/workers', 'D'),
  // E. Quality and Review (4)
  route('/review', 'E'),
  route('/review/:runId', 'E'),
  route('/review/:runId/rework', 'E'),
  route('/quality/history', 'E'),
  // F. Approval Center (3)
  route('/approvals', 'F'),
  route('/approvals/:id', 'F'),
  route('/approvals/history', 'F'),
  // G. Revisions and Deliverables (4)
  route('/deliverables', 'G'),
  route('/deliverables/:id', 'G'),
  route('/deliverables/:id/compare', 'G'),
  route('/deliverables/:id/delivery', 'G'),
  // H. Client Asset Library (3)
  route('/clients/:id/assets', 'H'),
  route('/clients/:id/assets/:assetId', 'H'),
  route('/clients/:id/brand', 'H'),
  // I. Integrations Center (3)
  route('/integrations', 'I'),
  route('/integrations/:name', 'I'),
  route('/integrations/auth', 'I'),
  // J. Costs (3)
  route('/costs', 'J'),
  route('/costs/budgets', 'J'),
  route('/costs/margin', 'J'),
  // K. Publishing and Deployment (2)
  route('/deployments', 'K'),
  route('/deployments/:id', 'K'),
  // L. Communications (1)
  route('/communications', 'L'),
  // M. Team and Access (1)
  route('/team', 'M'),
  // N. Audit and Incidents (1)
  route('/audit', 'N'),
];

export const COMMAND_CENTER_ROUTE_PATHS: ReadonlySet<string> = new Set(
  COMMAND_CENTER_ROUTES.map(r => r.path)
);

export function isApprovedRoute(path: string): boolean {
  return COMMAND_CENTER_ROUTE_PATHS.has(path);
}

// ─── Navigation taxonomy ────────────────────────────────────────────────────

export type Binding =
  | { kind: 'mapped'; route: string }
  /** No approved route exists. `reason` is shown to the operator, not swallowed. */
  | { kind: 'unmapped'; reason: string };

export interface Labels {
  en: string;
  el: string;
}

export type Locale = keyof Labels;

export interface Destination {
  id: string;
  labels: Labels;
  icon: LucideIcon;
  binding: Binding;
  /** Optional related approved routes, surfaced in the palette as sub-targets. */
  related?: readonly string[];
}

export interface NavigationGroup {
  id: string;
  labels: Labels;
  icon: LucideIcon;
  destinations: readonly Destination[];
}

const mapped = (path: string): Binding => ({ kind: 'mapped', route: path });
const unmapped = (reason: string): Binding => ({ kind: 'unmapped', reason });

/**
 * The owner's eight-group taxonomy. Where the approved IA has no route, the
 * destination stays visible but inert, with the real reason attached — the
 * navigation states the gap instead of hiding or faking it.
 */
export const NAVIGATION: readonly NavigationGroup[] = [
  {
    id: 'home',
    labels: { en: 'Home', el: 'Αρχική' },
    icon: Home,
    destinations: [
      {
        id: 'overview',
        labels: { en: 'Overview', el: 'Επισκόπηση' },
        icon: LayoutDashboard,
        binding: mapped('/'),
        related: ['/health'],
      },
      {
        id: 'today',
        labels: { en: 'Today', el: 'Σήμερα' },
        icon: CalendarDays,
        binding: unmapped('No approved route. The IA has no Today surface.'),
      },
      {
        id: 'notifications',
        labels: { en: 'Notifications', el: 'Ειδοποιήσεις' },
        icon: Bell,
        binding: unmapped(
          'No approved route. /communications is a different concept and is not treated as Notifications.'
        ),
      },
    ],
  },
  {
    id: 'agency',
    labels: { en: 'Agency', el: 'Πρακτορείο' },
    icon: Building2,
    destinations: [
      {
        id: 'clients',
        labels: { en: 'Clients', el: 'Πελάτες' },
        icon: Users,
        binding: mapped('/clients'),
        related: ['/clients/new'],
      },
      {
        id: 'crm-leads',
        labels: { en: 'CRM & Leads', el: 'CRM & Υποψήφιοι' },
        icon: TrendingUp,
        binding: unmapped(
          'No approved route. "lead" is a client lifecycle state in area B, not a screen.'
        ),
      },
      {
        id: 'projects',
        labels: { en: 'Projects', el: 'Έργα' },
        icon: FolderKanban,
        binding: mapped('/projects'),
        related: ['/projects/new', '/templates'],
      },
      {
        id: 'team',
        labels: { en: 'Team', el: 'Ομάδα' },
        icon: Users,
        binding: mapped('/team'),
      },
    ],
  },
  {
    id: 'production',
    labels: { en: 'Production', el: 'Παραγωγή' },
    icon: Boxes,
    destinations: [
      {
        id: 'production-board',
        labels: { en: 'Production Board', el: 'Πίνακας Παραγωγής' },
        icon: ListChecks,
        binding: unmapped(
          'Only project-scoped: /projects/:id/board. No global board route is approved.'
        ),
      },
      {
        id: 'workflows',
        labels: { en: 'Workflows', el: 'Ροές Εργασίας' },
        icon: GitPullRequest,
        binding: unmapped(
          'No approved route. Area D is mounted at /runs, which Live Runs already owns.'
        ),
      },
      {
        id: 'deliverables',
        labels: { en: 'Deliverables', el: 'Παραδοτέα' },
        icon: FileStack,
        binding: mapped('/deliverables'),
      },
      {
        id: 'assets',
        labels: { en: 'Assets', el: 'Πόροι' },
        icon: Image,
        binding: unmapped(
          'Only client-scoped: /clients/:id/assets. No global assets route is approved.'
        ),
      },
      {
        id: 'revisions',
        labels: { en: 'Revisions', el: 'Αναθεωρήσεις' },
        icon: Archive,
        binding: unmapped(
          'No approved route. Closest approved paths are /deliverables/:id/compare and /deliverables/:id/delivery.'
        ),
      },
    ],
  },
  {
    id: 'ai-workforce',
    labels: { en: 'AI Workforce', el: 'Δυναμικό AI' },
    icon: Brain,
    destinations: [
      {
        id: 'agents',
        labels: { en: 'Agents', el: 'Πράκτορες' },
        icon: Bot,
        binding: unmapped('No approved route. Agents appear inside /runs/:id, not as a screen.'),
      },
      {
        id: 'models',
        labels: { en: 'Models', el: 'Μοντέλα' },
        icon: Cpu,
        binding: unmapped('No approved route. Models appear inside /runs/:id, not as a screen.'),
      },
      {
        id: 'skills',
        labels: { en: 'Skills', el: 'Δεξιότητες' },
        icon: Sparkles,
        binding: unmapped('No approved route in the IA.'),
      },
      {
        id: 'tools',
        labels: { en: 'Tools', el: 'Εργαλεία' },
        icon: Wrench,
        binding: unmapped('No approved route in the IA.'),
      },
      {
        id: 'live-runs',
        labels: { en: 'Live Runs', el: 'Ζωντανές Εκτελέσεις' },
        icon: Activity,
        binding: mapped('/runs'),
      },
    ],
  },
  {
    id: 'governance',
    labels: { en: 'Governance', el: 'Διακυβέρνηση' },
    icon: ShieldCheck,
    destinations: [
      {
        id: 'approvals',
        labels: { en: 'Approvals', el: 'Εγκρίσεις' },
        icon: ClipboardCheck,
        binding: mapped('/approvals'),
        related: ['/approvals/history'],
      },
      {
        id: 'quality-gates',
        labels: { en: 'Quality Gates', el: 'Πύλες Ποιότητας' },
        icon: BadgeCheck,
        binding: mapped('/review'),
        related: ['/quality/history'],
      },
      {
        id: 'audit-trail',
        labels: { en: 'Audit Trail', el: 'Ίχνος Ελέγχου' },
        icon: ScrollText,
        binding: mapped('/audit'),
      },
      {
        id: 'quarantine',
        labels: { en: 'Quarantine', el: 'Καραντίνα' },
        icon: Trash2,
        binding: unmapped(
          'No approved route. Quarantine exists in governance artifacts, never as a screen.'
        ),
      },
    ],
  },
  {
    id: 'integrations',
    labels: { en: 'Integrations', el: 'Ενσωματώσεις' },
    icon: Plug,
    destinations: [
      {
        id: 'integrations-all',
        labels: { en: 'All', el: 'Όλες' },
        icon: Plug,
        binding: mapped('/integrations'),
      },
      {
        id: 'integrations-connected',
        labels: { en: 'Connected', el: 'Συνδεδεμένες' },
        icon: Link2,
        binding: unmapped('No approved route. The IA defines no filtered integration lists.'),
      },
      {
        id: 'integrations-login-required',
        labels: { en: 'Login Required', el: 'Απαιτείται Σύνδεση' },
        icon: KeyRound,
        // /integrations/auth is approved (area I). The PRD frames it as the
        // integration auth surface rather than a filtered list, so the link is
        // correct while the framing may be refined upstream.
        binding: mapped('/integrations/auth'),
      },
      {
        id: 'integrations-failed',
        labels: { en: 'Failed / Disabled', el: 'Αποτυχημένες / Ανενεργές' },
        icon: PlugZap,
        binding: unmapped('No approved route. The IA defines no filtered integration lists.'),
      },
    ],
  },
  {
    id: 'operations',
    labels: { en: 'Operations', el: 'Λειτουργίες' },
    icon: Server,
    destinations: [
      {
        id: 'workers-services',
        labels: { en: 'Workers & Services', el: 'Εργάτες & Υπηρεσίες' },
        icon: Server,
        binding: mapped('/workers'),
        related: ['/health'],
      },
      {
        id: 'autoscaling',
        labels: { en: 'Autoscaling', el: 'Αυτόματη Κλιμάκωση' },
        icon: Gauge,
        binding: unmapped('No approved route in the IA.'),
      },
      {
        id: 'costs-usage',
        labels: { en: 'Costs & Usage', el: 'Κόστη & Χρήση' },
        icon: CreditCard,
        binding: mapped('/costs'),
        related: ['/costs/budgets', '/costs/margin'],
      },
      {
        id: 'deployments',
        labels: { en: 'Deployments', el: 'Αναπτύξεις' },
        icon: Rocket,
        binding: mapped('/deployments'),
      },
      {
        id: 'incidents-rollbacks',
        labels: { en: 'Incidents & Rollbacks', el: 'Συμβάντα & Επαναφορές' },
        icon: AlertTriangle,
        binding: unmapped(
          'No approved route. Area N pairs incidents with /audit, which Audit Trail already owns; rollback is an API action only.'
        ),
      },
    ],
  },
  {
    id: 'settings',
    labels: { en: 'Settings', el: 'Ρυθμίσεις' },
    icon: Settings2,
    destinations: [
      {
        id: 'agency-profile',
        labels: { en: 'Agency Profile', el: 'Προφίλ Πρακτορείου' },
        icon: Building2,
        binding: unmapped('No approved route in the IA.'),
      },
      {
        id: 'roles-permissions',
        labels: { en: 'Roles & Permissions', el: 'Ρόλοι & Δικαιώματα' },
        icon: ShieldCheck,
        binding: unmapped(
          'No approved route. /team is "Team and Access", which the Team destination already owns.'
        ),
      },
      {
        id: 'settings-notifications',
        labels: { en: 'Notifications', el: 'Ειδοποιήσεις' },
        icon: Bell,
        binding: unmapped('No approved route in the IA.'),
      },
      {
        id: 'system-settings',
        labels: { en: 'System Settings', el: 'Ρυθμίσεις Συστήματος' },
        icon: SlidersHorizontal,
        binding: unmapped('No approved route in the IA.'),
      },
    ],
  },
];

// ─── Native Archon routes ───────────────────────────────────────────────────

export interface ArchonDestination {
  id: string;
  labels: Labels;
  icon: LucideIcon;
  /** Absolute in-app path. These are real, mounted Archon routes. */
  path: string;
}

/**
 * Archon's own screens, kept in a separate terminal section so no Command
 * Center group ever contains an Archon screen. Where names collide (Workflows,
 * Approvals, Deliverables) the group heading is the disambiguator.
 *
 * Sourced from ConsoleApp.tsx:80-102 and App.tsx:97-118. Only non-parameterized
 * routes appear — the project- and run-scoped ones need an id.
 */
export const ARCHON_DESTINATIONS: readonly ArchonDestination[] = [
  {
    id: 'archon-runs',
    labels: { en: 'Runs', el: 'Εκτελέσεις' },
    icon: Activity,
    path: '/console',
  },
  {
    id: 'archon-builder',
    labels: { en: 'Workflow Builder', el: 'Δημιουργός Ροών' },
    icon: GitPullRequest,
    path: '/console/builder',
  },
  {
    id: 'archon-control-plane',
    labels: { en: 'GoViral Control Plane', el: 'Πίνακας Ελέγχου GoViral' },
    icon: Gauge,
    path: '/console/goviral',
  },
  {
    id: 'archon-settings',
    labels: { en: 'Archon Settings', el: 'Ρυθμίσεις Archon' },
    icon: Settings2,
    path: '/console/settings',
  },
  {
    id: 'archon-workflows-classic',
    labels: { en: 'Workflows (classic)', el: 'Ροές Εργασίας (κλασικό)' },
    icon: FolderKanban,
    path: '/legacy/workflows',
  },
];

// ─── Derived helpers ────────────────────────────────────────────────────────

export function allDestinations(): readonly Destination[] {
  return NAVIGATION.flatMap(group => group.destinations);
}

export function findDestination(id: string): Destination | null {
  return allDestinations().find(d => d.id === id) ?? null;
}

export function findGroupOf(destinationId: string): NavigationGroup | null {
  return NAVIGATION.find(g => g.destinations.some(d => d.id === destinationId)) ?? null;
}

export function label(labels: Labels, locale: Locale): string {
  return labels[locale];
}
