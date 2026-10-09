/**
 * Server-to-server client for MeterMCP (apps/metermcp) on this machine: find the session behind a disputed PayPal
 * capture, read its receipt (JSON) and its receipt PDF. MeterMCP's admin routes need its per-launch token, which
 * it writes to apps/metermcp/.runtime-token; the file is read on every call so a restarted MeterMCP just works.
 */
import { readFileSync } from 'node:fs';
import type { Receipt } from '../../metermcp/src/receipt.ts';
import type { MeteredSession } from '../../web/src/domain/types.ts';

export type { Receipt };

export class MeterMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterMcpError';
  }
}

export interface MeterMcpSource {
  /** The session id whose PayPal capture is `captureId`, or null when MeterMCP has none. */
  findByCapture(captureId: string): Promise<string | null>;
  receipt(sessionId: string): Promise<Receipt>;
  receiptPdf(sessionId: string): Promise<Uint8Array>;
}

export class MeterMcpClient implements MeterMcpSource {
  private readonly base: string;
  private readonly tokenFile: string | null;
  private readonly token: string | null;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  /** Local: `tokenFile` (MeterMCP's per-launch token file). Hosted: `token` (the admin token shared through the env). */
  constructor(opts: { base: string; tokenFile?: string; token?: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.base = opts.base.replace(/\/$/, '');
    this.tokenFile = opts.tokenFile ?? null;
    this.token = opts.token || null;
    this.fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async get(path: string): Promise<Response> {
    let token = this.token;
    if (!token) {
      try {
        token = this.tokenFile ? readFileSync(this.tokenFile, 'utf8').trim() : '';
      } catch {
        throw new MeterMcpError('MeterMCP is not running (no runtime token)');
      }
      if (!token) throw new MeterMcpError('MeterMCP admin token is not configured');
    }
    let r: Response;
    try {
      r = await this.fetch(this.base + path, { headers: { 'x-metermcp-token': token }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new MeterMcpError('MeterMCP unreachable');
    }
    if (!r.ok) throw new MeterMcpError(`MeterMCP answered ${r.status}`);
    return r;
  }

  async findByCapture(captureId: string): Promise<string | null> {
    const r = (await (await this.get(`/sessions?capture=${encodeURIComponent(captureId)}`)).json()) as { sessions?: Array<{ id: string }> };
    return r.sessions?.[0]?.id ?? null;
  }

  async receipt(sessionId: string): Promise<Receipt> {
    return (await (await this.get(`/sessions/${encodeURIComponent(sessionId)}/receipt.json`)).json()) as Receipt;
  }

  async receiptPdf(sessionId: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.get(`/sessions/${encodeURIComponent(sessionId)}/receipt.pdf`)).arrayBuffer());
  }
}

/** MeterMCP's receipt → the web app's MeteredSession. Pure. */
export function toMeteredSession(r: Receipt): MeteredSession {
  return {
    sessionId: r.session.id,
    currency: r.session.currency,
    receiptSha256: r.receipt_sha256,
    mandate: {
      cap: r.mandate.cap,
      orderId: r.mandate.order_id,
      authorizationId: r.mandate.authorization_id,
      authorizationStatus: r.mandate.authorization_status,
      approvedAt: r.mandate.approved_at,
      authorizedAt: r.mandate.authorized_at,
    },
    calls: r.calls.map((c) => ({ n: c.n, time: c.time, tool: c.tool, price: c.price, status: c.status, requestHash: c.request_hash })),
    totals: { calls: r.totals.calls, ok: r.totals.ok, failed: r.totals.failed, charged: r.totals.charged, cap: r.totals.cap },
    settlement: {
      status: r.settlement.status,
      captureId: r.settlement.capture_id,
      captureStatus: r.settlement.capture_status,
      captured: r.settlement.captured,
      released: r.settlement.released,
      remainderReleased: r.settlement.remainder_released,
      settledAt: r.settlement.settled_at,
    },
  };
}

/** The receipt PDF's file name, as the web app names the attachment. */
export const receiptFileName = (sessionId: string) => `session-receipt-${sessionId}.pdf`;
