/**
 * Submission intents from the web app's side (see domain/intent.ts). With a ResolveKit server, the server composes
 * the intent from its own documents and analysis, records the approval and sends only that ({@link HttpIntentClient}).
 * Without a server (tests, a static preview) the simulator is the only PayPal and the same composition runs here
 * ({@link LocalIntentClient}); nothing can reach real PayPal that way.
 */
import { contentHash, type IntentRequest, type SubmissionIntent } from './intent';
import type { EvidenceSubmission, SentenceView } from './types';

/** One event of the server's audit log (apps/server/src/intents.ts). */
export interface ServerAuditEvent {
  at: string;
  caseId: string;
  kind: string;
  actor: string;
  disputeId?: string | null;
  intentId?: string;
  contentHash?: string;
  requestId?: string;
  detail?: string;
}

const short = (h: string | undefined) => (h ? `${h.slice(0, 12)}…` : '');

/** One server audit event as a line of the audit log (UTC time, who, what). */
export function auditLine(e: ServerAuditEvent): { time: string; who: string; what: string } {
  const d = new Date(e.at);
  const time = Number.isNaN(d.getTime()) ? '' : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const intent = e.intentId ? `intent ${e.intentId.slice(0, 12)}…` : '';
  const what: Record<string, string> = {
    intent_created: `Composed ${intent} · content sha256 ${short(e.contentHash)}`,
    intent_approved: `Approved ${intent} · content sha256 ${short(e.contentHash)}`,
    intent_cancelled: `Cancelled ${intent}`,
    intent_invalidated: `${intent} no longer sendable: ${e.detail ?? ''}`,
    send_started: `Sent provide_evidence${e.disputeId ? ` to dispute ${e.disputeId}` : ''} · request ${e.requestId ?? ''}`,
    sent: `PayPal accepted the send · request ${e.requestId ?? ''}`,
    send_failed: `Send failed: ${e.detail ?? ''} · request ${e.requestId ?? ''}`,
    send_refused: `Send refused before PayPal: ${e.detail ?? ''}`,
    edit_rechecked: `Re-checked an edited sentence · ${e.detail ?? ''}`,
    paypal_notified: `PayPal notified a change (webhook, signature verified) · ${e.detail ?? ''}`,
  };
  return { time, who: e.actor, what: (what[e.kind] ?? `${e.kind}${e.detail ? `: ${e.detail}` : ''}`).trim() };
}

/** A refusal by the server, with the reasons it gave (blockers, binding problems). */
export class IntentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reasons: string[];
  constructor(status: number, body: { error?: string; detail?: string; blockers?: string[]; reasons?: string[] }) {
    super(body.detail ?? body.error ?? `HTTP ${status}`);
    this.name = 'IntentError';
    this.status = status;
    this.code = body.error ?? `HTTP_${status}`;
    this.reasons = body.blockers ?? body.reasons ?? [];
  }
}

export interface IntentSource {
  /** Where intents come from: the server (source of truth) or this browser (no server: simulator only). */
  readonly kind: 'server' | 'local';
  /** Compose the intent. `local` is what this browser shows; only {@link LocalIntentClient} uses it. */
  create(caseId: string, req: IntentRequest, local: { submission: EvidenceSubmission; views: readonly SentenceView[] }): Promise<SubmissionIntent>;
  approve(intent: SubmissionIntent): Promise<SubmissionIntent>;
  /** The server's audit log of the case; null without a server. */
  events(caseId: string): Promise<ServerAuditEvent[] | null>;
}

export class HttpIntentClient implements IntentSource {
  readonly kind = 'server' as const;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  constructor(o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = o.base ?? '/api';
    this.fetch = o.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    let r: Response;
    try {
      r = await this.fetch(this.base + path, { ...init, signal: AbortSignal.timeout(45_000) });
    } catch {
      throw new IntentError(0, { error: 'SERVER_UNREACHABLE', detail: 'The ResolveKit server could not be reached' });
    }
    const body = (await r.json().catch(() => ({}))) as T & { error?: string; detail?: string };
    if (!r.ok) throw new IntentError(r.status, body);
    return body;
  }

  create(caseId: string, req: IntentRequest): Promise<SubmissionIntent> {
    return this.call(`/disputes/${encodeURIComponent(caseId)}/intent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  }

  approve(intent: SubmissionIntent): Promise<SubmissionIntent> {
    return this.call(`/disputes/${encodeURIComponent(intent.caseId)}/intent/${encodeURIComponent(intent.id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: intent.contentHash }),
    });
  }

  async events(caseId: string): Promise<ServerAuditEvent[] | null> {
    try {
      return (await this.call<{ events: ServerAuditEvent[] }>(`/disputes/${encodeURIComponent(caseId)}/audit`, { method: 'GET' })).events;
    } catch {
      return null;
    }
  }
}

const hex = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/** No server: the browser composes the simulator's intent from what it shows. */
export class LocalIntentClient implements IntentSource {
  readonly kind = 'local' as const;
  async create(caseId: string, req: IntentRequest, local: { submission: EvidenceSubmission; views: readonly SentenceView[] }): Promise<SubmissionIntent> {
    const s = local.submission;
    const content = {
      caseId,
      disputeId: null,
      documentsHash: '',
      analysisKey: '',
      evidenceType: req.evidenceType,
      carrier: s.carrier,
      tracking: s.tracking,
      notes: s.notes,
      files: s.files.map((f) => ({ ...f })),
      sentences: local.views.filter((v) => v.state === 'supported').map((v) => ({ id: v.id, text: v.text.trim(), edited: v.edited })),
      resolutionNotes: Object.entries(req.resolutions).flatMap(([contradictionId, r]) => (r.status === 'resolved' ? [{ contradictionId, note: r.note }] : [])),
    };
    const id = `int-${hex()}`;
    const now = new Date();
    return {
      ...content,
      id,
      contentHash: await contentHash(content),
      requestId: `rk-${id}`,
      status: 'proposed',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      reason: null,
    };
  }
  async approve(intent: SubmissionIntent): Promise<SubmissionIntent> {
    return { ...intent, status: 'approved', approvedBy: 'this browser', approvedAt: new Date().toISOString() };
  }
  async events(): Promise<null> {
    return null;
  }
}
