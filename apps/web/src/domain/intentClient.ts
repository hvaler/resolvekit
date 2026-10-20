/**
 * Submission intents from the web app's side (see domain/intent.ts). With a ResolveKit server, the server composes
 * the intent from its own documents and analysis, records the approval and sends only that ({@link HttpIntentClient}).
 * Without a server (tests, a static preview) the simulator is the only PayPal and the same composition runs here
 * ({@link LocalIntentClient}); nothing can reach real PayPal that way.
 */
import type { ProofState } from './actionReadback';
import { composeAction, confirmationTerms, duplicateKey, sameTerms, type ActionRequest, type ConfirmationTerms } from './actions';
import { contentHash, isComposeProblem, type IntentRequest, type SubmissionIntent } from './intent';
import type { DisputeSnapshot, EvidenceSubmission, SentenceView } from './types';

/** A composed action intent; `repeat`: PayPal already recorded this exact message on the dispute and stage. */
export type ActionIntent = SubmissionIntent & { repeat?: boolean };
/** An approved intent, with the terms of its second confirmation (null: none needed). */
export type ApprovedIntent = SubmissionIntent & { confirmation?: ConfirmationTerms | null };
/** What the server's read-back of an action's send proves, and the dispute as read. */
export interface ActionReadBack {
  readBack: { state: ProofState; detail: string; at?: string };
  snapshot: DisputeSnapshot | null;
  /** What holds the dispute after this read-back (null: nothing; absent: the server did not say). */
  hold?: DisputeHoldView | null;
}

/** The send holding a case's dispute (GET /api/disputes/:case/hold): no content, only what «Check again» needs. */
export interface DisputeHoldView {
  disputeId: string;
  intentId: string;
  caseId: string;
  since: string;
  state: 'in_flight' | 'uncertain';
  action: string | null;
  /** False: the server no longer has the intent (its intents file was lost); a read-back cannot settle it. */
  intentKnown: boolean;
  /** It is this person's own send. */
  own: boolean;
}

/** An intent a read-back is about: its case and id (the send holding a dispute may be a colleague's). */
export type IntentRef = Pick<SubmissionIntent, 'caseId' | 'id'>;

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
    upload_added: `Added evidence (pending review) · ${e.detail ?? ''}`,
    upload_redacted: `Covered what must not be shared · ${e.detail ?? ''}`,
    upload_confirmed: `Confirmed evidence · ${e.detail ?? ''}`,
    upload_discarded: `Discarded an upload · ${e.detail ?? ''}`,
    upload_deleted: `Deleted evidence · ${e.detail ?? ''}`,
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
  /** Approve exactly this content; an action's answer carries its second-confirmation terms (null when none). */
  approve(intent: SubmissionIntent): Promise<ApprovedIntent>;
  /** The server's audit log of the case; null without a server. */
  events(caseId: string): Promise<ServerAuditEvent[] | null>;
  /**
   * Compose an action (not evidence) against the dispute as just read. The server reads PayPal itself; this browser
   * ({@link LocalIntentClient}, the simulator) composes from `local.snapshot`, with the same rules.
   */
  createAction(caseId: string, req: ActionRequest, local: { snapshot: DisputeSnapshot | null }): Promise<ActionIntent>;
  /** The second confirmation: exactly the terms the approval gave ([A3]). */
  confirm(intent: SubmissionIntent, terms: ConfirmationTerms): Promise<SubmissionIntent>;
  /** The person saw the new buyer messages NEEDS_REVIEW showed (their keys); the same content goes on ([A5]). */
  acknowledge(intent: SubmissionIntent, shownMessageKeys: readonly string[]): Promise<SubmissionIntent>;
  /**
   * The server's read-back of an action's send (a POST that only reads PayPal); null without a server (the simulator
   * reads back in the browser). `intent` may be a colleague's send that holds the dispute.
   */
  readBack(intent: IntentRef): Promise<ActionReadBack | null>;
  /** The send holding the case's dispute, if any (a reloaded page offers «Check again» on it); null without a server. */
  hold(caseId: string): Promise<DisputeHoldView | null>;
  /**
   * The simulator proved this action recorded (its read-back in this browser). Only {@link LocalIntentClient} keeps it:
   * as the server's record of proven sends, it is what decides a repeated message. The server keeps its own.
   */
  proven?(intent: SubmissionIntent): void;
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

  approve(intent: SubmissionIntent): Promise<ApprovedIntent> {
    return this.call(`/disputes/${encodeURIComponent(intent.caseId)}/intent/${encodeURIComponent(intent.id)}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: intent.contentHash }),
    });
  }

  createAction(caseId: string, req: ActionRequest): Promise<ActionIntent> {
    return this.call(`/disputes/${encodeURIComponent(caseId)}/intent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  }

  private intentPath(i: IntentRef, step: string): string {
    return `/disputes/${encodeURIComponent(i.caseId)}/intent/${encodeURIComponent(i.id)}/${step}`;
  }

  confirm(intent: SubmissionIntent, terms: ConfirmationTerms): Promise<SubmissionIntent> {
    return this.call(this.intentPath(intent, 'confirm'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ terms }) });
  }

  acknowledge(intent: SubmissionIntent, shownMessageKeys: readonly string[]): Promise<SubmissionIntent> {
    return this.call(this.intentPath(intent, 'acknowledge'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: intent.contentHash, shownMessageKeys: [...shownMessageKeys] }),
    });
  }

  readBack(intent: IntentRef): Promise<ActionReadBack> {
    return this.call(this.intentPath(intent, 'readback'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  }

  async hold(caseId: string): Promise<DisputeHoldView | null> {
    return (await this.call<{ hold: DisputeHoldView | null }>(`/disputes/${encodeURIComponent(caseId)}/hold`, { method: 'GET' })).hold ?? null;
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
      ...(req.confirmedCorrections?.length ? { confirmedCorrections: [...req.confirmedCorrections] } : {}),
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
  async approve(intent: SubmissionIntent): Promise<ApprovedIntent> {
    const approved: SubmissionIntent = { ...intent, status: 'approved', approvedBy: 'this browser', approvedAt: new Date().toISOString() };
    if (!intent.action || intent.action === 'provide_evidence') return approved;
    return { ...approved, confirmation: confirmationTerms(approved, this.repeats.get(intent.id) ?? false) };
  }
  async events(): Promise<null> {
    return null;
  }

  /** Which of this browser's action intents repeat a message this browser already sent and proved recorded. */
  private readonly repeats = new Map<string, boolean>();
  /** The duplicate keys of the actions proven recorded on each simulated dispute (the server's recordedKeys). */
  private readonly recorded = new Map<string, Set<string>>();

  proven(intent: SubmissionIntent): void {
    const key = duplicateKey(intent);
    if (!key) return;
    const keys = this.recorded.get(intent.caseId) ?? new Set<string>();
    keys.add(key);
    this.recorded.set(intent.caseId, keys);
  }

  /**
   * Compose an action for the simulator with the same rules as the server, against `local.snapshot` (the dispute as
   * the simulator was just read). A message repeats one when this browser already sent the same message on the same
   * stage and proved it recorded, exactly as the live server decides it from its proven sends (never from the thread:
   * an offer's echoed note is not a message of ours): the same second confirmation (REPEATS_MESSAGE). No uploads exist
   * without a server.
   */
  async createAction(caseId: string, req: ActionRequest, local: { snapshot: DisputeSnapshot | null }): Promise<ActionIntent> {
    const snap = local.snapshot;
    if (!snap) throw new IntentError(409, { error: 'NOT_READ', detail: 'The dispute could not be read; nothing was composed' });
    if (req.attachments.length) throw new IntentError(409, { error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available in the simulator: an attachment needs the ResolveKit server' });
    const content = composeAction({ caseId, req, snap, disputeId: null, seller: null, files: [] });
    if (isComposeProblem(content)) throw new IntentError(content.status, { error: content.error, detail: content.detail });
    const id = `int-${hex()}`;
    const now = new Date();
    const intent: SubmissionIntent = {
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
    const p = content.payload;
    const key = duplicateKey(content);
    const repeat = p?.kind === 'send_message' && !!key && (this.recorded.get(caseId)?.has(key) ?? false);
    this.repeats.set(id, repeat);
    return { ...intent, repeat };
  }

  async confirm(intent: SubmissionIntent, terms: ConfirmationTerms): Promise<SubmissionIntent> {
    const own = confirmationTerms(intent, this.repeats.get(intent.id) ?? false);
    if (!own) throw new IntentError(409, { error: 'NO_CONFIRMATION', detail: 'This intent needs no second confirmation' });
    if (!sameTerms(own, terms)) throw new IntentError(409, { error: 'CONFIRMATION_MISMATCH', detail: 'These terms are not the ones of this intent; compose it again' });
    return intent;
  }

  /** The simulated buyer never writes, so there is never anything new to acknowledge. */
  async acknowledge(intent: SubmissionIntent): Promise<SubmissionIntent> {
    return intent;
  }

  async hold(): Promise<null> {
    return null;
  }

  async readBack(): Promise<null> {
    return null;
  }
}
