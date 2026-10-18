import type { DemoState } from './demoClient';
import type { ServerHealth } from './httpGateway';

/** Which of the app's areas is on screen: the public Explore demo, or the signed-in workspace. */
export type Area = 'demo' | 'workspace';

/** What the person is looking at, which decides what each screen offers. */
export type Environment =
  | { kind: 'demo' }
  | { kind: 'evaluation'; workspace: string }
  | { kind: 'merchant'; owner: boolean }
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'local' };

/** The demo area is always the demo; in the workspace it follows the account (null account state = local mode). */
export function environmentOf(area: Area, demo: DemoState | null): Environment {
  if (area === 'demo') return { kind: 'demo' };
  if (!demo) return { kind: 'local' };
  if (!demo.signedIn || !demo.workspace) return { kind: 'signed-out' };
  switch (demo.workspace.connection) {
    case 'evaluation':
      return { kind: 'evaluation', workspace: demo.workspace.name };
    case 'checking':
      return { kind: 'checking' };
    default:
      return { kind: 'merchant', owner: demo.person?.role === 'owner' };
  }
}

/** Where this area's case pages live. */
export function casesBase(area: Area): '/demo/cases' | '/cases' {
  return area === 'demo' ? '/demo/cases' : '/cases';
}

/** Drafts are kept per person; the demo's are shared by everyone, apart from every workspace draft. */
export function draftScope(area: Area, personId: string | null): string {
  return area === 'demo' ? 'demo' : (personId ?? 'local');
}

/** What `/cases` and `/cases/:id` show for this environment. `bound`: the case ids bound to real PayPal disputes. */
export type WorkspaceRoute =
  | { kind: 'inbox' }
  | { kind: 'case'; id: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'waiting' }
  | { kind: 'checking' }
  | { kind: 'retrying' };

/** The bound case ids once the server answered `/api/health`; null while unread or after a failed read (unknown). */
export function knownBound(health: ServerHealth | null): readonly string[] | null {
  return !health || health.failed ? null : health.bound;
}

/** How long to wait before asking `/api/health` again after `failures` failed reads in a row: 1 s, 2 s, 4 s… 30 s. */
export function healthRetryDelay(failures: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

/** The sign-in / join page, carrying where the person was going (`next`, a same-site path; `/` needs none). */
export const signInUrl = (next: string): string => withNext('/signin', next);
export const joinUrl = (next: string): string => withNext('/join', next);
function withNext(page: string, next: string): string {
  return next === '/' ? page : `${page}?next=${encodeURIComponent(next)}`;
}

/** `bound`: see {@link knownBound}; null (unknown) never sends a case link to the demo nor shows an empty inbox. */
export function workspaceRoute(env: Environment, path: { caseId: string | null }, bound: readonly string[] | null): WorkspaceRoute {
  const here = path.caseId ? `/cases/${path.caseId}` : '/cases';
  const page: WorkspaceRoute = path.caseId ? { kind: 'case', id: path.caseId } : { kind: 'inbox' };
  switch (env.kind) {
    case 'signed-out':
      return { kind: 'redirect', to: signInUrl(here) };
    case 'merchant':
      return { kind: 'waiting' };
    case 'checking':
      return { kind: 'checking' };
    case 'evaluation':
      if (!bound) return { kind: 'retrying' };
      // The evaluation workspace sees only its bound cases; any other id is the fictional case of the same id.
      return path.caseId && !bound.includes(path.caseId) ? { kind: 'redirect', to: `/demo/cases/${encodeURIComponent(path.caseId)}` } : page;
    default:
      return page;
  }
}

/** Where signing out leads: the home page, or straight to a fresh PayPal sign-in for "Use another PayPal account". */
export const signOutDestination = (another: boolean): string => (another ? '/signin' : '/');
