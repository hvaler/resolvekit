import { randomUUID } from 'node:crypto';
import { DisputesApi } from './disputes.ts';
import { IdentityApi } from './identity.ts';
import { OrdersApi, PaymentsApi } from './orders.ts';
import { WebhooksApi } from './webhooks.ts';

export type PayPalEnv = 'sandbox' | 'live';

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How the client waits before retrying a 429 (tests pass a recorder). */
  sleep?: (ms: number) => Promise<void>;
}

export class PayPalError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly debugId: string | null;

  // The debug_id is in the message so that every log line printing the error can be traced with PayPal.
  constructor(status: number, body: unknown, debugId: string | null) {
    const b = body as { name?: string; message?: string; details?: Array<{ issue?: string }> };
    const issues = b?.details?.map((d) => d.issue).filter(Boolean).join(', ');
    super(`PayPal ${status} ${b?.name ?? ''}${b?.message ? `: ${b.message}` : ''}${issues ? ` [${issues}]` : ''}${debugId ? ` (debug_id ${debugId})` : ''}`.replace(/ {2,}/g, ' ').trim());
    this.status = status;
    this.body = body;
    this.debugId = debugId;
  }
}

/** A JSON body already serialised by the caller, sent byte for byte (webhook verification carries the raw event). */
export class RawJson {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** 429 RATE_LIMIT_REACHED: attempts in all, and the longest wait honoured from Retry-After. */
const RATE_LIMIT_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5_000;

/**
 * The answer as JSON, or a PayPalError keeping status and debug_id when it is not JSON (an HTML error page from
 * PayPal's edge, a truncated body). Empty is {}. The raw body is never put in the error: it can be a whole page.
 */
async function readJson(r: Response): Promise<unknown> {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PayPalError(r.status, { name: 'NON_JSON_RESPONSE', message: `${r.headers.get('content-type') ?? 'no content-type'}, ${text.length} bytes` }, r.headers.get('paypal-debug-id'));
  }
}

/** Retry-After in ms (seconds or an HTTP date), capped; exponential from 1 s when absent or unreadable. */
function retryWait(r: Response, attempt: number): number {
  const h = r.headers.get('retry-after');
  const secs = h == null ? NaN : Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : h ? Date.parse(h) - Date.now() : NaN;
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, Number.isFinite(ms) ? ms : 1000 * 2 ** attempt));
}

const BASE: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export class PayPalClient {
  readonly disputes: DisputesApi;
  readonly identity: IdentityApi;
  readonly orders: OrdersApi;
  readonly payments: PaymentsApi;
  readonly webhooks: WebhooksApi;
  private readonly opts: Required<Omit<PayPalClientOptions, 'fetch'>> & { fetch: typeof fetch };
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: PayPalClientOptions) {
    this.opts = { timeoutMs: 60_000, fetch: globalThis.fetch.bind(globalThis), sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), ...opts };
    this.disputes = new DisputesApi(this);
    this.identity = new IdentityApi(this);
    this.orders = new OrdersApi(this);
    this.payments = new PaymentsApi(this);
    this.webhooks = new WebhooksApi(this);
  }

  /** Get (or reuse) an OAuth token: proves the credentials work without touching any dispute. */
  async verifyCredentials(): Promise<void> {
    await this.accessToken();
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const r = await this.opts.fetch(`${BASE[this.opts.env]}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const body = (await readJson(r)) as { access_token?: string; expires_in?: number };
    if (!r.ok) throw new PayPalError(r.status, body, r.headers.get('paypal-debug-id'));
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new PayPalError(r.status, { name: 'INVALID_TOKEN_RESPONSE' }, r.headers.get('paypal-debug-id'));
    }
    // Refresh a minute early.
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  // JSON or multipart request. Every POST carries a PayPal-Request-Id (the caller's own id when given). Whether
  // the Disputes API deduplicates on it is NOT verified, so callers must read the dispute back before any retry.
  // `headers` adds request headers (e.g. Prefer: return=representation); it cannot replace Authorization.
  // Only 429 is retried here (PayPal refused the request before acting on it), with the same PayPal-Request-Id
  // and body; any other failure goes to the caller, which knows whether a retry is safe. `noRetry` turns that off
  // (webhook verification: a delivery PayPal cannot confirm now is answered 503 and PayPal delivers it again).
  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown | FormData,
    opts: { requestId?: string; headers?: Record<string, string>; noRetry?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers, Authorization: `Bearer ${await this.accessToken()}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof RawJson) {
      headers['Content-Type'] = 'application/json';
      payload = body.text;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (method === 'POST') headers['PayPal-Request-Id'] = opts.requestId ?? randomUUID();
    for (let attempt = 0; ; attempt++) {
      const r = await this.opts.fetch(BASE[this.opts.env] + path, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (r.status === 429 && !opts.noRetry && attempt < RATE_LIMIT_ATTEMPTS - 1) {
        await r.body?.cancel();
        await this.opts.sleep(retryWait(r, attempt));
        continue;
      }
      const parsed = await readJson(r);
      if (!r.ok) throw new PayPalError(r.status, parsed, r.headers.get('paypal-debug-id'));
      return parsed as T;
    }
  }
}

export * from './disputes.ts';
export * from './identity.ts';
export * from './orders.ts';
export * from './webhooks.ts';
