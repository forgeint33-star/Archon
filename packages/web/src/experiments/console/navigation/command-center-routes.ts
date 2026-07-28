/**
 * Route contract between Archon's navigation bridge and the GoViral Agency
 * Command Center.
 *
 * SOURCE OF TRUTH — the Command Center's published route manifest, verified at
 * handoff on 2026-07-20:
 *
 *   file    /opt/goviral-command-center/current/route-manifest.json
 *   version 1.0.0   routes 61
 *   sha256  cf12629c09e2f87edd37d90c88bb87775dabb885c3013c753dd950c4b6769864
 *   agency  a2d8a7ecf9a8b3ad9318d5e10557d13e370ee435 (published == deployed)
 *
 * The 61 entries below are a mechanical transcription of that file, generated
 * from it rather than hand-typed. Two rules hold, and the contract test
 * enforces both:
 *
 *  1. COMMAND_CENTER_ROUTES matches the published manifest exactly. The test
 *     re-hashes the manifest on this host when it is present, so an upstream
 *     change fails CI instead of drifting silently.
 *  2. A navigation destination may only bind to a path that appears in that
 *     list, is `inNav`, and is not parameterized. Parameterized routes are
 *     reachable only through their own index screen — a top-level nav item can
 *     never fabricate an id.
 *
 * Inventing a path to fill a gap is the failure the Control Plane contract
 * hotfix removed. Do not do it here.
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

// ─── Manifest provenance ────────────────────────────────────────────────────

export const MANIFEST_VERSION = '1.0.0';
export const MANIFEST_ROUTE_COUNT = 62;
export const MANIFEST_SHA256 = 'b2235accbf670bd93e43587764f7dc46720758a75776e964fe46a39b5b81541b';
export const MANIFEST_PATH = '/opt/goviral-command-center/current/route-manifest.json';
export const AGENCY_DEPLOYED_COMMIT = 'df1650f8f3c0c6bf29e2f15d7721b85f1a7cc9b9';

/** Named by the manifest itself as non-production; never bundled for release. */
export const EXCLUDED_NON_PRODUCTION: readonly string[] = ['/console/_nav-preview'];

// ─── The published route list ───────────────────────────────────────────────

export type RouteGroup =
  | 'overview'
  | 'clients'
  | 'production'
  | 'delivery'
  | 'quality'
  | 'governance'
  | 'platform';

export type Capability =
  | 'assign_rework'
  | 'edit_client'
  | 'edit_project'
  | 'manage_team'
  | 'request_approval'
  | 'submit_run'
  | 'view_all_clients'
  | 'view_assigned_projects'
  | 'view_audit'
  | 'view_costs'
  | 'view_dashboard';

export interface RouteQuery {
  name: string;
  values: readonly string[];
}

export interface CommandCenterRoute {
  id: string;
  path: string;
  group: RouteGroup;
  capability: Capability;
  labels: Labels;
  params: readonly string[];
  availability: string;
  inNav: boolean;
  modal: boolean;
  parent: string | null;
  query?: RouteQuery;
}

export interface Labels {
  en: string;
  el: string;
}

export type Locale = keyof Labels;

/** Transcribed from the published manifest — do not edit by hand. */
export const COMMAND_CENTER_ROUTES: readonly CommandCenterRoute[] = [
  {
    id: 'agents',
    path: '/agents',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Agents', el: 'Πράκτορες' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'approvals',
    path: '/approvals',
    group: 'governance',
    capability: 'request_approval',
    labels: { en: 'Approvals', el: 'Εγκρίσεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'approvals.detail',
    path: '/approvals/:approvalId',
    group: 'governance',
    capability: 'request_approval',
    labels: { en: 'Approval', el: 'Έγκριση' },
    params: ['approvalId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/approvals',
  },
  {
    id: 'approvals.history',
    path: '/approvals/history',
    group: 'governance',
    capability: 'request_approval',
    labels: { en: 'Approval history', el: 'Ιστορικό εγκρίσεων' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/approvals',
  },
  {
    id: 'assets',
    path: '/assets',
    group: 'delivery',
    capability: 'view_all_clients',
    labels: { en: 'Assets', el: 'Υλικό' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'audit',
    path: '/audit',
    group: 'governance',
    capability: 'view_audit',
    labels: { en: 'Audit trail', el: 'Ίχνος ελέγχου' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'clients',
    path: '/clients',
    group: 'clients',
    capability: 'view_all_clients',
    labels: { en: 'Clients', el: 'Πελάτες' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'clients.detail',
    path: '/clients/:clientId',
    group: 'clients',
    capability: 'view_all_clients',
    labels: { en: 'Client', el: 'Πελάτης' },
    params: ['clientId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients',
  },
  {
    id: 'clients.detail.assets',
    path: '/clients/:clientId/assets',
    group: 'delivery',
    capability: 'view_all_clients',
    labels: { en: 'Asset library', el: 'Βιβλιοθήκη υλικού' },
    params: ['clientId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients/:clientId',
  },
  {
    id: 'clients.detail.assets.detail',
    path: '/clients/:clientId/assets/:assetId',
    group: 'delivery',
    capability: 'view_all_clients',
    labels: { en: 'Asset', el: 'Στοιχείο' },
    params: ['clientId', 'assetId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients/:clientId/assets',
  },
  {
    id: 'clients.detail.brand',
    path: '/clients/:clientId/brand',
    group: 'delivery',
    capability: 'view_all_clients',
    labels: { en: 'Brand kit', el: 'Brand kit' },
    params: ['clientId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients/:clientId',
  },
  {
    id: 'clients.detail.contacts',
    path: '/clients/:clientId/contacts',
    group: 'clients',
    capability: 'view_all_clients',
    labels: { en: 'Contacts', el: 'Επαφές' },
    params: ['clientId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients/:clientId',
  },
  {
    id: 'clients.detail.contracts',
    path: '/clients/:clientId/contracts',
    group: 'clients',
    capability: 'view_all_clients',
    labels: { en: 'Contracts', el: 'Συμβάσεις' },
    params: ['clientId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/clients/:clientId',
  },
  {
    id: 'clients.new',
    path: '/clients/new',
    group: 'clients',
    capability: 'edit_client',
    labels: { en: 'New client', el: 'Νέος πελάτης' },
    params: [],
    availability: 'available',
    inNav: false,
    modal: true,
    parent: '/clients',
  },
  {
    id: 'communications',
    path: '/communications',
    group: 'platform',
    capability: 'view_assigned_projects',
    labels: { en: 'Communications', el: 'Επικοινωνίες' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'costs',
    path: '/costs',
    group: 'platform',
    capability: 'view_costs',
    labels: { en: 'Costs', el: 'Κόστη' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'costs.budgets',
    path: '/costs/budgets',
    group: 'platform',
    capability: 'view_costs',
    labels: { en: 'Budgets', el: 'Προϋπολογισμοί' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/costs',
  },
  {
    id: 'costs.margin',
    path: '/costs/margin',
    group: 'platform',
    capability: 'view_costs',
    labels: { en: 'Profitability', el: 'Κερδοφορία' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/costs',
  },
  {
    id: 'crm',
    path: '/crm',
    group: 'clients',
    capability: 'view_all_clients',
    labels: { en: 'CRM', el: 'Πελατολόγιο' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'dashboard',
    path: '/',
    group: 'overview',
    capability: 'view_dashboard',
    labels: { en: 'Dashboard', el: 'Πίνακας ελέγχου' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'deliverables',
    path: '/deliverables',
    group: 'delivery',
    capability: 'view_assigned_projects',
    labels: { en: 'Deliverables', el: 'Παραδοτέα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'deliverables.detail',
    path: '/deliverables/:deliverableId',
    group: 'delivery',
    capability: 'view_assigned_projects',
    labels: { en: 'Deliverable', el: 'Παραδοτέο' },
    params: ['deliverableId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/deliverables',
  },
  {
    id: 'deliverables.detail.compare',
    path: '/deliverables/:deliverableId/compare',
    group: 'delivery',
    capability: 'view_assigned_projects',
    labels: { en: 'Compare versions', el: 'Σύγκριση εκδόσεων' },
    params: ['deliverableId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/deliverables/:deliverableId',
  },
  {
    id: 'deliverables.detail.delivery',
    path: '/deliverables/:deliverableId/delivery',
    group: 'delivery',
    capability: 'view_assigned_projects',
    labels: { en: 'Delivery', el: 'Παράδοση' },
    params: ['deliverableId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/deliverables/:deliverableId',
  },
  {
    id: 'deployments',
    path: '/deployments',
    group: 'platform',
    capability: 'view_assigned_projects',
    labels: { en: 'Deployments', el: 'Αναπτύξεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'deployments.detail',
    path: '/deployments/:deploymentId',
    group: 'platform',
    capability: 'view_assigned_projects',
    labels: { en: 'Deployment', el: 'Ανάπτυξη' },
    params: ['deploymentId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/deployments',
  },
  {
    id: 'health',
    path: '/health',
    group: 'overview',
    capability: 'view_dashboard',
    labels: { en: 'Runtime health', el: 'Υγεία συστήματος' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/',
  },
  {
    id: 'integrations',
    path: '/integrations',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Integrations', el: 'Ενσωματώσεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
    query: { name: 'state', values: ['connected', 'login-required'] },
  },
  {
    id: 'integrations.auth',
    path: '/integrations/auth',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Binding readiness', el: 'Ετοιμότητα σύνδεσης' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/integrations',
  },
  {
    id: 'integrations.detail',
    path: '/integrations/:name',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Integration', el: 'Ενσωμάτωση' },
    params: ['name'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/integrations',
  },
  {
    id: 'models',
    path: '/models',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Models', el: 'Μοντέλα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'notifications',
    path: '/notifications',
    group: 'overview',
    capability: 'view_assigned_projects',
    labels: { en: 'Notifications', el: 'Ειδοποιήσεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'operations.autoscaling',
    path: '/operations/autoscaling',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Autoscaling', el: 'Αυτόματη κλιμάκωση' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'operations.incidents',
    path: '/operations/incidents',
    group: 'governance',
    capability: 'view_audit',
    labels: { en: 'Incidents', el: 'Συμβάντα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'production',
    path: '/production',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Production', el: 'Παραγωγή' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'projects',
    path: '/projects',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Projects', el: 'Έργα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'projects.detail',
    path: '/projects/:projectId',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Project', el: 'Έργο' },
    params: ['projectId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/projects',
  },
  {
    id: 'projects.detail.board',
    path: '/projects/:projectId/board',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Production board', el: 'Πίνακας παραγωγής' },
    params: ['projectId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/projects/:projectId',
  },
  {
    id: 'projects.detail.timeline',
    path: '/projects/:projectId/timeline',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Timeline', el: 'Χρονοδιάγραμμα' },
    params: ['projectId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/projects/:projectId',
  },
  {
    id: 'projects.new',
    path: '/projects/new',
    group: 'production',
    capability: 'edit_project',
    labels: { en: 'New project', el: 'Νέο έργο' },
    params: [],
    availability: 'available',
    inNav: false,
    modal: true,
    parent: '/projects',
  },
  {
    id: 'quality.history',
    path: '/quality/history',
    group: 'quality',
    capability: 'view_assigned_projects',
    labels: { en: 'Quality history', el: 'Ιστορικό ποιότητας' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'quarantine',
    path: '/quarantine',
    group: 'governance',
    capability: 'view_dashboard',
    labels: { en: 'Quarantine', el: 'Καραντίνα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'review',
    path: '/review',
    group: 'quality',
    capability: 'view_assigned_projects',
    labels: { en: 'Review queue', el: 'Ουρά ελέγχου' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'review.detail',
    path: '/review/:runId',
    group: 'quality',
    capability: 'view_assigned_projects',
    labels: { en: 'Review', el: 'Έλεγχος' },
    params: ['runId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/review',
  },
  {
    id: 'review.detail.rework',
    path: '/review/:runId/rework',
    group: 'quality',
    capability: 'assign_rework',
    labels: { en: 'Rework', el: 'Επανεργασία' },
    params: ['runId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/review/:runId',
  },
  {
    id: 'revisions',
    path: '/revisions',
    group: 'delivery',
    capability: 'view_assigned_projects',
    labels: { en: 'Revisions', el: 'Αναθεωρήσεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'runs',
    path: '/runs',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Runs', el: 'Εκτελέσεις' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'runs.detail',
    path: '/runs/:runId',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Run', el: 'Εκτέλεση' },
    params: ['runId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/runs',
  },
  {
    id: 'runs.detail.events',
    path: '/runs/:runId/events',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Live events', el: 'Ζωντανά συμβάντα' },
    params: ['runId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/runs/:runId',
  },
  {
    id: 'runs.detail.outputs',
    path: '/runs/:runId/outputs',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Outputs', el: 'Αποτελέσματα' },
    params: ['runId'],
    availability: 'available',
    inNav: false,
    modal: false,
    parent: '/runs/:runId',
  },
  {
    id: 'settings.access',
    path: '/settings/access',
    group: 'governance',
    capability: 'manage_team',
    labels: { en: 'Roles and access', el: 'Ρόλοι και πρόσβαση' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/settings/agency',
  },
  {
    id: 'settings.agency',
    path: '/settings/agency',
    group: 'governance',
    capability: 'view_dashboard',
    labels: { en: 'Agency settings', el: 'Ρυθμίσεις πρακτορείου' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'settings.notifications',
    path: '/settings/notifications',
    group: 'governance',
    capability: 'view_assigned_projects',
    labels: { en: 'Notification settings', el: 'Ρυθμίσεις ειδοποιήσεων' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/settings/agency',
  },
  {
    id: 'settings.system',
    path: '/settings/system',
    group: 'governance',
    capability: 'manage_team',
    labels: { en: 'System readiness', el: 'Ετοιμότητα συστήματος' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/settings/agency',
  },
  {
    id: 'skills',
    path: '/skills',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Skills', el: 'Δεξιότητες' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'submit',
    path: '/submit',
    group: 'production',
    capability: 'submit_run',
    labels: { en: 'Submit a run', el: 'Υποβολή εκτέλεσης' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'team',
    path: '/team',
    group: 'governance',
    capability: 'view_audit',
    labels: { en: 'Team and access', el: 'Ομάδα και πρόσβαση' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'templates',
    path: '/templates',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Templates', el: 'Πρότυπα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'today',
    path: '/today',
    group: 'overview',
    capability: 'view_dashboard',
    labels: { en: 'Today', el: 'Σήμερα' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: '/',
  },
  {
    id: 'tools',
    path: '/tools',
    group: 'platform',
    capability: 'view_dashboard',
    labels: { en: 'Tools', el: 'Εργαλεία' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'workers',
    path: '/workers',
    group: 'production',
    capability: 'view_dashboard',
    labels: { en: 'Workers', el: 'Εργάτες' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
  {
    id: 'workflows',
    path: '/workflows',
    group: 'production',
    capability: 'view_assigned_projects',
    labels: { en: 'Workflows', el: 'Ροές εργασίας' },
    params: [],
    availability: 'available',
    inNav: true,
    modal: false,
    parent: null,
  },
];

export const COMMAND_CENTER_ROUTE_PATHS: ReadonlySet<string> = new Set(
  COMMAND_CENTER_ROUTES.map(r => r.path)
);

const ROUTE_BY_PATH: ReadonlyMap<string, CommandCenterRoute> = new Map(
  COMMAND_CENTER_ROUTES.map(r => [r.path, r])
);

export function findRoute(path: string): CommandCenterRoute | null {
  return ROUTE_BY_PATH.get(path) ?? null;
}

export function isApprovedRoute(path: string): boolean {
  return COMMAND_CENTER_ROUTE_PATHS.has(path);
}

/**
 * A path is bindable by a top-level nav item only when the manifest marks it
 * `inNav` and it takes no path parameters. Parameterized screens are reached
 * through their own index, never by fabricating an id.
 */
export function isBindable(path: string): boolean {
  const route = findRoute(path);
  return route !== null && route.inNav && route.params.length === 0;
}

// ─── Navigation taxonomy ────────────────────────────────────────────────────

export type Binding =
  /** Bound to a published, navigable route. `query` narrows it to a validated filter value. */
  | { kind: 'mapped'; route: string; query?: { name: string; value: string } }
  /** No published route or validated filter value exists. `reason` is shown, never swallowed. */
  | { kind: 'unmapped'; reason: string };

export interface Destination {
  id: string;
  /** Fallback labels; manifest labels win when the binding resolves. */
  labels: Labels;
  icon: LucideIcon;
  binding: Binding;
  related?: readonly string[];
}

export interface NavigationGroup {
  id: string;
  labels: Labels;
  icon: LucideIcon;
  destinations: readonly Destination[];
}

const mapped = (route: string, query?: { name: string; value: string }): Binding =>
  query ? { kind: 'mapped', route, query } : { kind: 'mapped', route };
const unmapped = (reason: string): Binding => ({ kind: 'unmapped', reason });

/**
 * The owner's eight-group taxonomy, reconciled against manifest 1.0.0.
 *
 * 33 of 34 destinations now bind to a published route. The single exception is
 * the Integrations "Failed / Disabled" filter: the manifest validates exactly
 * two `state` values, `connected` and `login-required`, and inventing a third
 * would assert a filter the Command Center does not implement.
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
        binding: mapped('/today'),
      },
      {
        id: 'notifications',
        labels: { en: 'Notifications', el: 'Ειδοποιήσεις' },
        icon: Bell,
        binding: mapped('/notifications'),
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
      },
      {
        id: 'crm-leads',
        labels: { en: 'CRM & Leads', el: 'CRM & Υποψήφιοι' },
        icon: TrendingUp,
        binding: mapped('/crm'),
      },
      {
        id: 'projects',
        labels: { en: 'Projects', el: 'Έργα' },
        icon: FolderKanban,
        binding: mapped('/projects'),
        related: ['/templates'],
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
        binding: mapped('/production'),
      },
      {
        id: 'workflows',
        labels: { en: 'Workflows', el: 'Ροές Εργασίας' },
        icon: GitPullRequest,
        binding: mapped('/workflows'),
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
        binding: mapped('/assets'),
      },
      {
        id: 'revisions',
        labels: { en: 'Revisions', el: 'Αναθεωρήσεις' },
        icon: Archive,
        binding: mapped('/revisions'),
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
        binding: mapped('/agents'),
      },
      {
        id: 'models',
        labels: { en: 'Models', el: 'Μοντέλα' },
        icon: Cpu,
        binding: mapped('/models'),
      },
      {
        id: 'skills',
        labels: { en: 'Skills', el: 'Δεξιότητες' },
        icon: Sparkles,
        binding: mapped('/skills'),
      },
      {
        id: 'tools',
        labels: { en: 'Tools', el: 'Εργαλεία' },
        icon: Wrench,
        binding: mapped('/tools'),
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
        binding: mapped('/quarantine'),
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
        related: ['/integrations/auth'],
      },
      {
        id: 'integrations-connected',
        labels: { en: 'Connected', el: 'Συνδεδεμένες' },
        icon: Link2,
        binding: mapped('/integrations', { name: 'state', value: 'connected' }),
      },
      {
        id: 'integrations-login-required',
        labels: { en: 'Login Required', el: 'Απαιτείται Σύνδεση' },
        icon: KeyRound,
        binding: mapped('/integrations', { name: 'state', value: 'login-required' }),
        related: ['/integrations/auth'],
      },
      {
        id: 'integrations-failed',
        labels: { en: 'Failed / Disabled', el: 'Αποτυχημένες / Ανενεργές' },
        icon: PlugZap,
        // Manifest 1.0.0 validates exactly two `state` values: connected and
        // login-required. There is no failed/disabled filter to link to, and
        // inventing one would assert a filter the Command Center does not have.
        binding: unmapped(
          'The Command Center validates only the "connected" and "login-required" integration state filters. No failed/disabled filter is published.'
        ),
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
        binding: mapped('/operations/autoscaling'),
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
        binding: mapped('/operations/incidents'),
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
        binding: mapped('/settings/agency'),
      },
      {
        id: 'roles-permissions',
        labels: { en: 'Roles & Permissions', el: 'Ρόλοι & Δικαιώματα' },
        icon: ShieldCheck,
        binding: mapped('/settings/access'),
      },
      {
        id: 'settings-notifications',
        labels: { en: 'Notifications', el: 'Ειδοποιήσεις' },
        icon: Bell,
        binding: mapped('/settings/notifications'),
      },
      {
        id: 'system-settings',
        labels: { en: 'System Settings', el: 'Ρυθμίσεις Συστήματος' },
        icon: SlidersHorizontal,
        binding: mapped('/settings/system'),
      },
    ],
  },
];

// ─── Native Archon routes ───────────────────────────────────────────────────

export interface ArchonDestination {
  id: string;
  labels: Labels;
  icon: LucideIcon;
  path: string;
}

/**
 * Archon's own screens, kept in a separate terminal section so no Command
 * Center group ever contains an Archon screen. Where names collide (Workflows)
 * the section heading is the disambiguator.
 *
 * Sourced from ConsoleApp.tsx and App.tsx. Only non-parameterized routes appear.
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

/**
 * The manifest's own label wins over the local fallback, so Archon renders the
 * Command Center's wording rather than a private translation that could drift.
 */
export function destinationLabels(destination: Destination): Labels {
  if (destination.binding.kind !== 'mapped') return destination.labels;
  const route = findRoute(destination.binding.route);
  if (!route) return destination.labels;

  // A filtered destination is a narrowed view of its index; the index label
  // would be wrong for it, so the local label stands.
  return destination.binding.query ? destination.labels : route.labels;
}

/** The capability the Command Center requires for this destination, if bound. */
export function destinationCapability(destination: Destination): Capability | null {
  if (destination.binding.kind !== 'mapped') return null;
  return findRoute(destination.binding.route)?.capability ?? null;
}

export function label(labels: Labels, locale: Locale): string {
  return labels[locale];
}
