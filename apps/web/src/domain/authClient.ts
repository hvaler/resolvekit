/**
 * Sign-in calls of the hosted demo (apps/server auth.ts): PayPal for merchants, invite links with a passkey or for
 * this browser for members, passkey sign-in, and the Owner's member management. The browser never holds a token: the
 * server sets an HttpOnly session cookie.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

export type AuthResult<T = null> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export interface InviteView {
  workspace: { name: string };
  role: 'member';
  reviewer: boolean;
  expiresAt: string;
  accessUntil: string | null;
  usesLeft: number;
}

export interface MemberRow {
  id: string;
  name: string;
  role: 'owner' | 'member';
  via: 'paypal' | 'passkey' | 'browser';
  email: string | null;
  reviewer: boolean;
  accessUntil: string | null;
  createdAt: string;
  lastActiveAt: string;
  revokedAt: string | null;
  passkeys: number;
}

export interface InviteRow {
  id: string;
  label: string;
  reviewer: boolean;
  maxUses: number;
  uses: number;
  expiresAt: string;
  accessUntil: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** What `/signin?error=…` means, in words. */
export const SIGN_IN_ERRORS: Record<string, string> = {
  cancelled: 'You cancelled on PayPal. Nothing was shared.',
  not_approved: 'PayPal did not confirm the approval. Try again.',
  session_mismatch: 'That sign-in was started in another browser or has expired. Start again here.',
  paypal_unavailable: 'PayPal could not be reached. Try again in a moment.',
  paypal_off: 'PayPal sign-in is not set up on this server.',
  unavailable: 'Your account could not be saved. Try again later.',
  full: 'This demo has reached its number of workspaces.',
};

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

export class AuthClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  constructor(o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = o.base ?? '/api';
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AuthResult<T>> {
    try {
      const r = await this.fetch(this.base + path, {
        method,
        credentials: 'same-origin',
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      const b = (await r.json().catch(() => ({}))) as T & { error?: string; detail?: string };
      if (r.ok) return { ok: true, value: b };
      return { ok: false, error: b.detail ?? `The server answered ${r.status}.`, ...(b.error ? { code: b.error } : {}) };
    } catch {
      return { ok: false, error: 'The server could not be reached.' };
    }
  }

  /**
   * PayPal's approval link: the caller sends the browser there; PayPal sends it back signed in, to `next` (a same-site
   * path the server checks again) or, without one, to the start page.
   */
  paypalStart(next = '/') {
    return this.call<{ approvalUrl: string }>('POST', '/auth/paypal/start', next === '/' ? {} : { next });
  }

  inspectInvite(token: string) {
    return this.call<InviteView>('POST', '/auth/invite/inspect', { token });
  }

  joinThisBrowser(token: string, name: string) {
    return this.call<{ person: { name: string } }>('POST', '/auth/invite/join', { token, name });
  }

  /** Create a passkey on this device and join the invite's workspace with it. */
  async joinWithPasskey(token: string, name: string): Promise<AuthResult> {
    const opts = await this.call<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/auth/passkey/register/options', { token, name });
    if (!opts.ok) return opts;
    let response;
    try {
      response = await startRegistration({ optionsJSON: opts.value });
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === 'NotAllowedError' ? 'The passkey was not created (cancelled or timed out).' : 'This device could not create a passkey.' };
    }
    const v = await this.call('POST', '/auth/passkey/register/verify', { response });
    return v.ok ? { ok: true, value: null } : v;
  }

  async signInWithPasskey(): Promise<AuthResult> {
    const opts = await this.call<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/auth/passkey/login/options');
    if (!opts.ok) return opts;
    let response;
    try {
      response = await startAuthentication({ optionsJSON: opts.value });
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === 'NotAllowedError' ? 'No passkey was used (cancelled or timed out).' : 'This device could not use a passkey.' };
    }
    const v = await this.call('POST', '/auth/passkey/login/verify', { response });
    return v.ok ? { ok: true, value: null } : v;
  }

  members() {
    return this.call<{ members: MemberRow[]; invites: InviteRow[] }>('GET', '/workspace/members');
  }

  createInvite(o: { label: string; reviewer: boolean; maxUses: number; ttlDays: number; accessUntil: string | null }) {
    return this.call<{ invite: InviteRow; url: string }>('POST', '/workspace/invites', o);
  }

  revokeInvite(id: string) {
    return this.call<InviteRow>('POST', `/workspace/invites/${encodeURIComponent(id)}/revoke`);
  }

  revokeMember(id: string) {
    return this.call<MemberRow>('POST', `/workspace/members/${encodeURIComponent(id)}/revoke`);
  }
}
