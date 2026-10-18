/**
 * The hosted demo's account state (`/api/demo` and `/api/auth/me` on the ResolveKit server in hosted mode). Browsing is
 * free; composing and approving a response needs a signed-in person; the real PayPal disputes, sending evidence to them
 * and live AI runs belong to the seller's workspace (signed in with the seller's PayPal account, or joined with its
 * invite). The session is an HttpOnly cookie the server sets. Locally (no hosted server) there is no sign-in.
 */
export type DemoAction = 'evidence' | 'live-analysis' | 'recheck' | 'upload';

export interface AccountPerson {
  id: string;
  name: string;
  role: 'owner' | 'member';
  via: 'paypal' | 'passkey' | 'browser';
  email: string | null;
  reviewer: boolean;
  accessUntil: string | null;
}

export interface AccountWorkspace {
  id: string;
  name: string;
  /** Its PayPal account is the seller on the connected disputes: they are live for it. */
  connected: boolean;
  /** `evaluation`: the evaluation workspace (live for it); `not_connected`: a merchant's own; `checking`: not known yet. */
  connection: 'evaluation' | 'not_connected' | 'checking';
}

export interface DemoState {
  signedIn: boolean;
  person: AccountPerson | null;
  workspace: AccountWorkspace | null;
  expiresAt: string | null;
  /** How one can sign in on this server. */
  methods: { paypal: boolean; passkey: boolean };
  /** The costly actions are open to this person: signed in to the seller's workspace. */
  unlocked: boolean;
  /** Why each costly action is the seller workspace's, as the server words it. */
  reasons: Partial<Record<DemoAction, string>>;
  caps: Partial<Record<DemoAction, { limit: number; used: number; remaining: number }>>;
  resetsAt?: string;
}

function parseConnection(c: unknown): AccountWorkspace['connection'] {
  return c === 'evaluation' || c === 'checking' ? c : 'not_connected';
}

export const SIGN_IN_FIRST = 'Sign in to do this: with PayPal if you are the merchant, or with the invite link you were given.';

export class DemoClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  constructor(o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = o.base ?? '/api';
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** The account state, or null when this server has no sign-in (local mode, or no server). */
  async state(): Promise<DemoState | null> {
    try {
      const [d, m] = await Promise.all([
        this.fetch(`${this.base}/demo`, { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) }),
        this.fetch(`${this.base}/auth/me`, { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) }).catch(() => null),
      ]);
      if (!d.ok) return null;
      const demo = (await d.json()) as { hosted?: boolean; reasons?: DemoState['reasons']; caps?: DemoState['caps']; resetsAt?: string };
      if (!demo.hosted) return null;
      const me = m && m.ok ? ((await m.json()) as { signedIn?: boolean; person?: AccountPerson; workspace?: Omit<AccountWorkspace, 'connection'> & { connection?: AccountWorkspace['connection'] }; expiresAt?: string; methods?: DemoState['methods'] }) : {};
      const signedIn = !!me.signedIn && !!me.person && !!me.workspace;
      return {
        signedIn,
        person: signedIn ? me.person! : null,
        workspace: signedIn ? { ...me.workspace!, connection: parseConnection(me.workspace!.connection) } : null,
        expiresAt: signedIn ? (me.expiresAt ?? null) : null,
        methods: { paypal: !!me.methods?.paypal, passkey: me.methods?.passkey !== false },
        unlocked: signedIn && !!me.workspace?.connected,
        reasons: demo.reasons ?? {},
        caps: demo.caps ?? {},
        ...(demo.resetsAt ? { resetsAt: demo.resetsAt } : {}),
      };
    } catch {
      return null;
    }
  }

  async signOut(everywhere = false): Promise<void> {
    try {
      await this.fetch(`${this.base}/auth/signout`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ everywhere }) });
    } catch {
      // The session expires on its own.
    }
  }
}

/** Why `action` is not open right now, or null (open, or no sign-in on this server). */
export function lockedReason(demo: DemoState | null, action: DemoAction): string | null {
  if (!demo || demo.unlocked) return null;
  if (!demo.signedIn) return SIGN_IN_FIRST;
  return demo.reasons[action] ?? 'Only the seller’s workspace can do this.';
}

/** "Dana Ruiz" → "DR"; "Judge 2 (rehearsal)" → "JR": the first letter of the first and last words that have one. */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((w) => /\p{L}/u.exec(w)?.[0])
    .filter((x): x is string => !!x);
  return ((letters[0] ?? '') + (letters.length > 1 ? letters[letters.length - 1]! : '')).toUpperCase() || '?';
}

/** The merchant in local mode (no sign-in): the operator at this machine. */
export const LOCAL_MERCHANT = 'Alex Moreno';

/** Who is acting in this browser, as the page names them: the signed-in person, else the local merchant. */
export function actorName(demo: Pick<DemoState, 'person'> | null | undefined): string {
  return demo?.person?.name ?? LOCAL_MERCHANT;
}

/** The person's role as shown: "Owner", "Member", "Reviewer". */
export function roleLabel(p: Pick<AccountPerson, 'role' | 'reviewer'>): string {
  return p.role === 'owner' ? 'Owner' : p.reviewer ? 'Reviewer' : 'Member';
}
