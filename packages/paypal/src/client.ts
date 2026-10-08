import { randomUUID } from 'node:crypto';
import { DisputesApi } from './disputes.ts';

export type PayPalEnv = 'sandbox' | 'live';

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class PayPalError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly debugId: string | null;

  constructor(status: number, body: unknown, debugId: string | null) {
    const b = body as { name?: string; message?: string; details?: Array<{ issue?: string }> };
    const issues = b?.details?.map((d) => d.issue).filter(Boolean).join(', ');
    super(`PayPal ${status} ${b?.name ?? ''}${b?.message ? `: ${b.message}` : ''}${issues ? ` [${issues}]` : ''}`.trim());
    this.status = status;
    this.body = body;
    this.debugId = debugId;
  }
}

const BASE: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export class PayPalClient {
  readonly disputes: DisputesApi;
  private readonly opts: Required<Omit<PayPalClientOptions, 'fetch'>> & { fetch: typeof fetch };
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: PayPalClientOptions) {
    this.opts = { timeoutMs: 60_000, fetch: globalThis.fetch.bind(globalThis), ...opts };
    this.disputes = new DisputesApi(this);
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
    const body = await r.json();
    if (!r.ok) throw new PayPalError(r.status, body, r.headers.get('paypal-debug-id'));
    // Refresh a minute early.
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  // JSON or multipart request. Every POST carries a PayPal-Request-Id so a retry cannot duplicate an action.
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown | FormData): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (method === 'POST') headers['PayPal-Request-Id'] = randomUUID();
    const r = await this.opts.fetch(BASE[this.opts.env] + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const text = await r.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!r.ok) throw new PayPalError(r.status, parsed, r.headers.get('paypal-debug-id'));
    return parsed as T;
  }
}
