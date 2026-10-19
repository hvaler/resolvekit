/**
 * Dispute actions other than evidence (B): what the merchant asks for (an {@link ActionRequest}), the part of the
 * intent that is hashed for it (an {@link ActionPayload}) and the dispute as it was when the intent was composed (a
 * {@link DisputePin}). Types stay strings here; the contract registry decides which variants are available.
 */
import { parseAmount } from './amounts.ts';
import type { ComposeProblem, IntentContent, IntentRequest } from './intent.ts';

/** The actions composed from a text and options, without the analysis. */
export type SimpleAction = 'send_message' | 'accept_claim' | 'escalate' | 'make_offer';
/** Every action an intent can carry (provide_evidence and appeal are composed from the analysis). */
export type IntentAction = 'provide_evidence' | 'appeal' | SimpleAction;

export interface Money {
  /** Canonical decimal string for the currency (amounts.ts), e.g. `7.00`. */
  value: string;
  currency: string;
}

/** At most this many characters in a message or a note (trimmed). */
export const ACTION_TEXT_LIMIT = 2000;

export type ActionRequest =
  | { action: 'send_message'; text: string; attachments: string[] }
  | { action: 'accept_claim'; acceptType: string; note: string; amount: Money | null; attachments: [] }
  | { action: 'escalate'; note: string; attachments: [] }
  | { action: 'make_offer'; offerType: string; note: string; amount: Money | null; attachments: [] };

/** What an action intent sends, hashed with it. */
export type ActionPayload =
  | { kind: 'send_message'; text: string }
  | { kind: 'accept_claim'; acceptType: string; note: string; amount: Money | null }
  | { kind: 'escalate'; note: string }
  | { kind: 'make_offer'; offerType: string; note: string; amount: Money | null };

/** The dispute at compose time: a send finds it changed (another stage, status or amount) and refuses. */
export interface DisputePin {
  disputeId: string | null;
  seller: string | null;
  stage: string | null;
  status: string;
  amount: Money | null;
}

/** The evidence fields of an action intent, which carries none. */
export const ACTION_EVIDENCE_BLANK: Pick<IntentContent, 'documentsHash' | 'analysisKey' | 'evidenceType' | 'carrier' | 'tracking' | 'notes' | 'sentences' | 'resolutionNotes'> = {
  documentsHash: '',
  analysisKey: '',
  evidenceType: 'OTHER',
  carrier: '',
  tracking: '',
  notes: '',
  sentences: [],
  resolutionNotes: [],
};

const SIMPLE_ACTIONS: readonly string[] = ['send_message', 'accept_claim', 'escalate', 'make_offer'] satisfies SimpleAction[];

export const isSimpleAction = (a: unknown): a is SimpleAction => typeof a === 'string' && SIMPLE_ACTIONS.includes(a);

/** The intent's action: an intent without one is evidence (as every intent was before actions). */
export const intentAction = (c: IntentContent): IntentAction => c.action ?? 'provide_evidence';

export const isActionRequest = (r: IntentRequest | ActionRequest): r is ActionRequest => isSimpleAction(r.action);

/** The server's CONTROL_CHARS (apps/server/src/app.ts): control and bidi characters; line breaks and tabs are allowed. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const UPLOAD_ID = /^upl-[0-9a-f]{24}$/;
const TYPE_CODE = /^[A-Z_]{1,60}$/;
const CURRENCY = /^[A-Z]{3}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const FIELDS: Readonly<Record<SimpleAction, readonly string[]>> = {
  send_message: ['action', 'text', 'attachments'],
  accept_claim: ['action', 'acceptType', 'note', 'amount', 'attachments'],
  escalate: ['action', 'note', 'attachments'],
  make_offer: ['action', 'offerType', 'note', 'amount', 'attachments'],
};

/** Parse a request body into an {@link ActionRequest}; shape, text and amount only (the dispute is checked at compose). */
export function parseActionRequest(body: unknown): ActionRequest | ComposeProblem {
  const bad = (detail: string): ComposeProblem => ({ status: 400, error: 'INVALID_ACTION_REQUEST', detail });
  if (!isRecord(body)) return bad('Body must be a JSON object');
  const action = body.action;
  if (!isSimpleAction(action)) return bad('action must be send_message, accept_claim, escalate or make_offer');
  const extra = Object.keys(body).filter((k) => !FIELDS[action].includes(k));
  if (extra.length) return bad(`Unexpected field(s) ${extra.join(', ')} for ${action}`);

  const text = (name: string): string | ComposeProblem => {
    const v = body[name];
    if (typeof v !== 'string') return bad(`${name} must be a string`);
    if (CONTROL_CHARS.test(v)) return bad(`${name} must not contain control or bidi characters`);
    const t = v.trim();
    if (!t) return { status: 422, error: 'TEXT_REQUIRED', detail: `Type the ${name === 'text' ? 'message' : 'note'}` };
    if (t.length > ACTION_TEXT_LIMIT) return { status: 422, error: 'TEXT_TOO_LONG', detail: `The ${name === 'text' ? 'message' : 'note'} must be at most ${ACTION_TEXT_LIMIT} characters` };
    return t;
  };
  const code = (name: string): string | ComposeProblem => {
    const v = body[name];
    return typeof v === 'string' && TYPE_CODE.test(v) ? v : bad(`${name} must be a PayPal type code`);
  };
  const amount = (): Money | null | ComposeProblem => {
    const v = body.amount;
    if (v === undefined || v === null) return null;
    if (!isRecord(v) || Object.keys(v).some((k) => k !== 'value' && k !== 'currency')) return bad('amount must be { value, currency } or null');
    if (typeof v.value !== 'string' || typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) return bad('amount must be { value: "7.50", currency: "USD" }');
    const r = parseAmount(v.value, v.currency);
    return r.ok ? { value: r.value, currency: v.currency } : { status: 422, error: r.error, detail: r.detail };
  };
  const isProblem = (x: unknown): x is ComposeProblem => isRecord(x) && typeof x.error === 'string';

  if (action === 'send_message') {
    const a = body.attachments ?? [];
    if (!Array.isArray(a) || a.length > 1) return bad('attachments must be a list of at most 1 upload id');
    if (!a.every((id) => typeof id === 'string' && UPLOAD_ID.test(id))) return bad('attachments: invalid upload id');
    const t = text('text');
    return isProblem(t) ? t : { action, text: t, attachments: [...(a as string[])] };
  }
  if (body.attachments !== undefined && !(Array.isArray(body.attachments) && body.attachments.length === 0)) return bad(`${action} takes no attachments`);
  const kind = action === 'accept_claim' ? code('acceptType') : action === 'make_offer' ? code('offerType') : '';
  if (isProblem(kind)) return kind;
  const note = text('note');
  if (isProblem(note)) return note;
  if (action === 'escalate') return { action, note, attachments: [] };
  const m = amount();
  if (isProblem(m)) return m;
  return action === 'accept_claim' ? { action, acceptType: kind, note, amount: m, attachments: [] } : { action, offerType: kind, note, amount: m, attachments: [] };
}
