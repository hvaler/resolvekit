import { GatewayTimeoutError, GatewayUnavailableError, type DisputeGateway } from './gateway';
import type { DisputeSnapshot, EvidenceSubmission } from './types';

/** What the ResolveKit server says about its PayPal connection (`GET /api/health`). */
export interface ServerHealth {
  paypal: 'sandbox' | 'live' | 'unconfigured';
  /** Case ids bound to a real PayPal dispute. */
  bound: string[];
  error?: string;
  /** The health read itself failed (timeout, 429, 5xx, no server): what is bound is unknown, not "nothing". */
  failed?: true;
}

/** A refusal from the server or from PayPal, with PayPal's issue code when there is one. */
export class GatewayRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly paypalIssue: string | null;
  constructor(status: number, body: { error?: string; detail?: string; paypalIssue?: string }) {
    const code = body.error ?? `HTTP ${status}`;
    super([body.paypalIssue, body.detail ?? (body.paypalIssue ? null : code)].filter(Boolean).join(': ') || code);
    this.name = 'GatewayRequestError';
    this.status = status;
    this.code = code;
    this.paypalIssue = body.paypalIssue ?? null;
  }
}

export interface HttpGatewayOptions {
  base?: string;
  fetch?: typeof fetch;
  readTimeoutMs?: number;
  /** The server reads the dispute, then sends: allow for two PayPal calls. */
  sendTimeoutMs?: number;
}

/**
 * The real gateway: the ResolveKit server (`apps/server`), which talks to PayPal with `packages/paypal`. The browser
 * never holds PayPal credentials. A request that runs out of time becomes {@link GatewayTimeoutError}, so the
 * caller reads the dispute back instead of guessing.
 */
export class HttpDisputeGateway implements DisputeGateway {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly readTimeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(opts: HttpGatewayOptions = {}) {
    this.base = opts.base ?? '/api';
    this.fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.readTimeoutMs = opts.readTimeoutMs ?? 35_000;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? 75_000;
  }

  private async call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let r: Response;
    try {
      r = await this.fetch(this.base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new GatewayTimeoutError();
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new GatewayTimeoutError();
      throw new GatewayUnavailableError('The ResolveKit server could not be reached');
    }
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (r.status === 504) throw new GatewayTimeoutError();
    if (!r.ok) throw new GatewayRequestError(r.status, body);
    return body;
  }

  getDispute(caseId: string): Promise<DisputeSnapshot> {
    return this.call<DisputeSnapshot>(`/disputes/${encodeURIComponent(caseId)}`, { method: 'GET' }, this.readTimeoutMs);
  }

  /**
   * Send an approved submission intent. Only its id goes to the server, which sends the intent's own content (with the
   * intent's PayPal-Request-Id); a submission without an intent is never sent.
   */
  async provideEvidence(submission: EvidenceSubmission, _opts?: { requestId: string }): Promise<void> {
    if (!submission.intentId) throw new GatewayRequestError(400, { error: 'NO_INTENT', detail: 'Only an approved submission intent can be sent to PayPal' });
    await this.call<{ sent: true }>(
      `/disputes/${encodeURIComponent(submission.disputeId)}/evidence`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intentId: submission.intentId }) },
      this.sendTimeoutMs,
    );
  }

  /** The server's PayPal connection; "unconfigured" if the server is not running or cannot reach PayPal. */
  async health(timeoutMs = 8_000): Promise<ServerHealth> {
    try {
      const h = await this.call<ServerHealth>('/health', { method: 'GET' }, timeoutMs);
      const paypal = h.paypal === 'sandbox' || h.paypal === 'live' ? h.paypal : 'unconfigured';
      return { paypal, bound: paypal === 'unconfigured' ? [] : Array.isArray(h.bound) ? h.bound : [], ...(h.error ? { error: h.error } : {}) };
    } catch (e) {
      return { paypal: 'unconfigured', bound: [], failed: true, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Where each case is served from: a bound case goes to real PayPal (when the server reports it connected). */
export type GatewayMode = { kind: 'paypal'; env: 'sandbox' | 'live' } | { kind: 'simulator' };

export function modeFor(caseId: string, health: ServerHealth | null): GatewayMode {
  if (health && health.paypal !== 'unconfigured' && health.bound.includes(caseId)) return { kind: 'paypal', env: health.paypal };
  return { kind: 'simulator' };
}

/** Sends each case to the real gateway or the simulator according to {@link modeFor}, decided per call. */
export class RoutingDisputeGateway implements DisputeGateway {
  constructor(
    private readonly real: DisputeGateway,
    private readonly simulated: DisputeGateway,
    private readonly mode: (caseId: string) => GatewayMode,
  ) {}

  private pick(caseId: string): DisputeGateway {
    return this.mode(caseId).kind === 'paypal' ? this.real : this.simulated;
  }

  getDispute(caseId: string): Promise<DisputeSnapshot> {
    return this.pick(caseId).getDispute(caseId);
  }

  provideEvidence(submission: EvidenceSubmission, opts: { requestId: string }): Promise<void> {
    return this.pick(submission.disputeId).provideEvidence(submission, opts);
  }
}
