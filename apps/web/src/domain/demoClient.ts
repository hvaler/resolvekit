/**
 * The hosted demo's lock (`/api/demo…` on the ResolveKit server in hosted mode). Browsing is free; sending evidence
 * to real PayPal and live AI runs need the demo code from the Devpost testing instructions. The unlock is an
 * HttpOnly cookie the server sets: the browser never stores the code. Locally (no hosted server) there is no lock.
 */
export type DemoAction = 'evidence' | 'live-analysis' | 'recheck';

export interface DemoState {
  unlockable: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  /** Why each action needs the code, as the server words it. */
  reasons: Partial<Record<DemoAction, string>>;
  caps: Partial<Record<DemoAction, { limit: number; used: number; remaining: number }>>;
  resetsAt?: string;
}

export type UnlockResult = { ok: true; state: DemoState } | { ok: false; error: string };

const json = { 'content-type': 'application/json' };

export class DemoClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  constructor(o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = o.base ?? '/api';
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** The lock state, or null when this server has no lock (local mode, or no server). */
  async state(): Promise<DemoState | null> {
    try {
      const r = await this.fetch(`${this.base}/demo`, { credentials: 'same-origin', signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return null;
      const b = (await r.json()) as Partial<DemoState> & { hosted?: boolean };
      return b.hosted ? toState(b) : null;
    } catch {
      return null;
    }
  }

  async unlock(code: string): Promise<UnlockResult> {
    try {
      const r = await this.fetch(`${this.base}/demo/unlock`, { method: 'POST', headers: json, credentials: 'same-origin', body: JSON.stringify({ code }), signal: AbortSignal.timeout(10_000) });
      const b = (await r.json().catch(() => ({}))) as Partial<DemoState> & { error?: string; detail?: string };
      if (r.ok) return { ok: true, state: toState(b) };
      if (r.status === 403) return { ok: false, error: 'That is not the demo code.' };
      if (r.status === 429) return { ok: false, error: b.detail ?? 'Too many attempts; try again later.' };
      return { ok: false, error: b.detail ?? `The server answered ${r.status}.` };
    } catch {
      return { ok: false, error: 'The server could not be reached.' };
    }
  }

  async lock(): Promise<void> {
    try {
      await this.fetch(`${this.base}/demo/lock`, { method: 'POST', headers: json, credentials: 'same-origin', body: '{}' });
    } catch {
      // Expires on its own.
    }
  }
}

function toState(b: Partial<DemoState>): DemoState {
  return {
    unlockable: !!b.unlockable,
    unlocked: !!b.unlocked,
    expiresAt: b.expiresAt ?? null,
    reasons: b.reasons ?? {},
    caps: b.caps ?? {},
    ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}),
  };
}

/** Why `action` is locked right now, or null (unlocked, or no lock on this server). */
export function lockedReason(demo: DemoState | null, action: DemoAction): string | null {
  if (!demo || demo.unlocked) return null;
  return demo.reasons[action] ?? 'This action needs the demo code.';
}
