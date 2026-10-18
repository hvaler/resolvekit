import type { DemoState } from './demoClient';

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
export type WorkspaceRoute = { kind: 'inbox' } | { kind: 'case'; id: string } | { kind: 'redirect'; to: string } | { kind: 'waiting' } | { kind: 'checking' };

export function workspaceRoute(env: Environment, path: { caseId: string | null }, bound: readonly string[]): WorkspaceRoute {
  const here = path.caseId ? `/cases/${path.caseId}` : '/cases';
  const page: WorkspaceRoute = path.caseId ? { kind: 'case', id: path.caseId } : { kind: 'inbox' };
  switch (env.kind) {
    case 'signed-out':
      return { kind: 'redirect', to: `/signin?next=${encodeURIComponent(here)}` };
    case 'merchant':
      return { kind: 'waiting' };
    case 'checking':
      return { kind: 'checking' };
    case 'evaluation':
      // The evaluation workspace sees only its bound cases; any other id is the fictional case of the same id.
      return path.caseId && !bound.includes(path.caseId) ? { kind: 'redirect', to: `/demo/cases/${path.caseId}` } : page;
    default:
      return page;
  }
}
