/**
 * Dispute actions other than evidence (B): what the merchant asks for (an {@link ActionRequest}), the part of the
 * intent that is hashed for it (an {@link ActionPayload}) and the dispute as it was when the intent was composed (a
 * {@link DisputePin}). Types stay strings here; the contract registry decides which variants are available.
 */
import { canonicalJson } from '@resolvekit/analyst';
import { CONTRACTS, variantOf, type VariantContract, type VariantId } from './actionContracts.ts';
import { CURRENCY_EXPONENT, formatMoney, minorUnits, parseAmount } from './amounts.ts';
import type { ComposeProblem, IntentContent, IntentRequest, SubmissionIntent } from './intent.ts';
import type { DisputeMessage, DisputeSnapshot, SubmissionFile } from './types';

/** The actions composed from a text and options, without the analysis. */
export type SimpleAction = 'send_message' | 'accept_claim' | 'escalate' | 'make_offer';
/** Every action an intent can carry (provide_evidence and appeal are composed from the analysis). */
export type IntentAction = 'provide_evidence' | 'appeal' | SimpleAction;

export interface Money {
  /** Canonical decimal string for the currency (amounts.ts), e.g. `7.00`. */
  value: string;
  currency: string;
}

/**
 * At most this many characters in a message or a note (trimmed). Counted in UTF-16 code units (String.length), never
 * fewer than code points, so it never lets through more than PayPal could count.
 */
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

/** What the owner's second confirmation names for each action ([A3]): a changed code means a new intent. */
export const CONSEQUENCE: Readonly<Record<Exclude<IntentAction, 'provide_evidence'>, string>> = {
  send_message: 'BUYER_SEES_MESSAGE',
  accept_claim: 'REFUNDS_BUYER',
  escalate: 'MOVES_TO_CLAIM',
  make_offer: 'OFFERS_SETTLEMENT',
  appeal: 'APPEALS_DECISION',
};
/** The consequence code of a message whose exact text PayPal already recorded on this dispute and stage. */
export const REPEATS_MESSAGE = 'REPEATS_MESSAGE';
/**
 * The consequence code of a partial accept (W-9): PayPal records it as an offer the buyer must agree to, so it is never
 * confirmed as REFUNDS_BUYER (nothing is refunded or closed unless the buyer accepts).
 */
export const OFFERS_PARTIAL_REFUND = 'OFFERS_PARTIAL_REFUND';

/** A partial accept: an offer to the buyer at PayPal (W-9), not a refund. */
const isPartialAccept = (c: Pick<IntentContent, 'payload'>): boolean => c.payload?.kind === 'accept_claim' && c.payload.acceptType === 'PARTIAL_REFUND';

/**
 * The duplicate guard's key ([A1]): the same simple action with the same content on the same stage (the dispute is the
 * store's key). Null for evidence and appeal, which have their own guards.
 */
export function duplicateKey(c: IntentContent): string | null {
  const action = intentAction(c);
  if (!isSimpleAction(action) || !c.payload) return null;
  return `${action}|${c.pin?.stage ?? null}|${canonicalJson(c.payload)}`;
}

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

  const text = (name: string, optional = false): string | ComposeProblem => {
    const v = body[name];
    if (optional && v === undefined) return '';
    if (typeof v !== 'string') return bad(`${name} must be a string`);
    if (CONTROL_CHARS.test(v)) return bad(`${name} must not contain control or bidi characters`);
    const t = v.trim();
    if (!t && optional) return '';
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
  // The same test as intent.ts's isComposeProblem, kept here so this module imports only types from intent.ts (which
  // imports this module's values): no value-import cycle.
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
  // PayPal's accept-claim note is optional; escalate and make_offer need one.
  const note = text('note', action === 'accept_claim');
  if (isProblem(note)) return note;
  if (action === 'escalate') return { action, note, attachments: [] };
  const m = amount();
  if (isProblem(m)) return m;
  return action === 'accept_claim' ? { action, acceptType: kind, note, amount: m, attachments: [] } : { action, offerType: kind, note, amount: m, attachments: [] };
}

// ---------------------------------------------------------------------------------------------
// Availability, compose, the second confirmation and new buyer messages (B0). Pure: the server and the in-browser
// simulator use the same rules. Availability is rebuilt only from a fresh dispute read and the contract registry.

/** Actions that move money or change the dispute's stage: the workspace owner only. */
export const OWNER_ACTIONS: readonly IntentAction[] = ['accept_claim', 'make_offer', 'escalate', 'appeal'];

/** Who is asking: a reviewer is a member who joined through a reviewer link. */
export interface Viewer {
  role: 'owner' | 'member';
  reviewer: boolean;
}

export interface ActionAvailability {
  action: IntentAction;
  /** PayPal offers the action now (its link is in the fresh read). */
  offered: boolean;
  /** This viewer can compose and send it now, in at least one variant. */
  sendable: boolean;
  /** Why it is not sendable; null when it is. */
  why: string | null;
  /** `variant` null: a type PayPal offers that no ResolveKit variant covers (never available). */
  variants: Array<{ variant: VariantId | null; type: string | null; available: boolean; why: string | null }>;
}

export type ContractRegistry = Readonly<Record<VariantId, VariantContract>>;

const NOT_OFFERED = 'PayPal does not offer this action on this dispute right now';
const OWNER_ONLY = 'Only the workspace owner can send this action';
const NO_TYPE = 'PayPal offers no type for this action on this dispute right now';
const UNCOVERED_TYPES = 'ResolveKit cannot send the types PayPal offers on this dispute';
const UNCOVERED_TYPE = 'ResolveKit cannot send this type';

const ownerOk = (action: IntentAction, who: Viewer): boolean => !OWNER_ACTIONS.includes(action) || (who.role === 'owner' && !who.reviewer);

/** The types of an action PayPal allows now (allowed_response_options), or the fixed variants of the others. */
function variantTypes(snap: DisputeSnapshot, action: IntentAction): Array<string | null> {
  switch (action) {
    case 'send_message':
      return [null, 'file'];
    case 'accept_claim':
      return [...(snap.responseOptions?.acceptClaimTypes ?? [])];
    case 'make_offer':
      return [...(snap.responseOptions?.offerTypes ?? [])];
    case 'escalate':
    case 'appeal':
      return [null];
    case 'provide_evidence':
      return [];
  }
}

/**
 * What a viewer can do with an action on the dispute as just read: offered when PayPal's link is there; each variant
 * PayPal allows, available only when its contract is recorded (with the registry's reason otherwise); owner-only
 * actions refused to anyone else. Nothing is inferred from earlier reads or local state.
 */
export function actionAvailability(snap: DisputeSnapshot, action: IntentAction, who: Viewer): ActionAvailability {
  return actionAvailabilityWith(snap, action, who, CONTRACTS);
}

/** {@link actionAvailability} against a given registry. Internal: for tests with test-only contracts. */
export function actionAvailabilityWith(snap: DisputeSnapshot, action: IntentAction, who: Viewer, contracts: ContractRegistry): ActionAvailability {
  const offered = snap.allowedActions.includes(action);
  const variants: ActionAvailability['variants'] = variantTypes(snap, action).map((type) => {
    const variant = variantOf(action, type);
    if (!variant) return { variant: null, type, available: false, why: UNCOVERED_TYPE };
    const c = contracts[variant];
    if (c.status === 'not_available') return { variant, type, available: false, why: c.reason ?? 'Not available' };
    const outside = action === 'accept_claim' && type ? acceptOutsideContract(type, snap) : action === 'escalate' ? escalateOutsideContract(snap) : null;
    return { variant, type, available: !outside, why: outside };
  });
  // Evidence keeps its own flow (its variants are checked where it is composed).
  const withVariants = action !== 'provide_evidence';
  const covered = variants.filter((v) => v.variant !== null);
  let why: string | null = null;
  if (!offered) why = NOT_OFFERED;
  else if (!ownerOk(action, who)) why = OWNER_ONLY;
  else if (withVariants && variants.length === 0) why = NO_TYPE;
  else if (withVariants && covered.length === 0) why = UNCOVERED_TYPES;
  else if (withVariants && !covered.some((v) => v.available)) why = covered[0]!.why;
  return { action, offered, sendable: why === null, why, variants };
}

/** The dispute as read now, as an intent pins it. */
export function disputePin(snap: DisputeSnapshot, disputeId: string | null, seller: string | null): DisputePin {
  return { disputeId, seller, stage: snap.stage ?? null, status: snap.status, amount: snap.amount ? { value: snap.amount.value, currency: snap.amount.currency } : null };
}

/** The rules of one action, from its contract. They land with each action (Tasks 8–12). */
export interface ActionRules {
  /** Stages the contract recorded the action on; null: any stage. */
  stages: readonly string[] | null;
  amount: 'required' | 'not_allowed' | 'optional';
  /** The amount must be below the dispute amount (a partial refund), not just at most it. */
  belowDispute?: boolean;
  /** A second upper bound, strictly below which the amount must be (a partial accept: what PayPal would refund). */
  belowAmount?: Money;
  /** Why this request is outside what the contract recorded (refused VARIANT_NOT_AVAILABLE before anything else). */
  unavailable?: string;
  text: 'required' | 'optional';
}
export type RulesOf = (req: ActionRequest, snap: DisputeSnapshot) => ActionRules | null;

/**
 * The stages the recorded contracts saw each action on ([A2]); another stage is refused ACTION_STAGE.
 * send_message: W-1, W-2 and W-3 (packages/paypal/contracts/send_message*.json) were INQUIRY before and after.
 */
export const RECORDED_STAGES: Readonly<Partial<Record<SimpleAction, readonly string[]>>> = Object.freeze({
  send_message: Object.freeze(['INQUIRY']),
  // W-9 and W-10 (packages/paypal/contracts/accept_claim-*.json): INQUIRY before and after.
  accept_claim: Object.freeze(['INQUIRY']),
  // W-5 (packages/paypal/contracts/escalate.json): sent from INQUIRY; the claim (CHARGEBACK) came minutes later.
  escalate: Object.freeze(['INQUIRY']),
});

/**
 * Each action's rules, from its contract; an action without rules is refused VARIANT_NOT_AVAILABLE (Tasks 9–12 add
 * theirs). send_message: the text is required (at most ACTION_TEXT_LIMIT), no amount; at most one confirmed upload,
 * which makes it the `send_message:file` variant and so needs that variant available in the registry.
 */
export const ACTION_RULES: Readonly<Partial<Record<SimpleAction, RulesOf>>> = Object.freeze({
  send_message: (): ActionRules => ({ stages: RECORDED_STAGES.send_message!, amount: 'not_allowed', text: 'required' }),
  // accept_claim, as recorded on not-received disputes: REFUND takes no amount (W-10: PayPal refunded the disputed
  // amount, which equalled its allowed_refund_amount); PARTIAL_REFUND takes `refund_amount`, below the dispute amount
  // and below what PayPal would refund (W-9: 2.00 of 7.00). A note is required: no accept without one was recorded.
  // Anything outside that (another reason, another refundable amount) is unavailable; other types have no rules.
  accept_claim: (req, snap): ActionRules | null => {
    if (req.action !== 'accept_claim' || (req.acceptType !== 'REFUND' && req.acceptType !== 'PARTIAL_REFUND')) return null;
    const outside = acceptOutsideContract(req.acceptType, snap);
    const r: ActionRules =
      req.acceptType === 'REFUND'
        ? { stages: RECORDED_STAGES.accept_claim!, amount: 'not_allowed', text: 'required' }
        : { stages: RECORDED_STAGES.accept_claim!, amount: 'required', belowDispute: true, ...(snap.allowedRefund ? { belowAmount: snap.allowedRefund } : {}), text: 'required' };
    return outside ? { ...r, unavailable: outside } : r;
  },
  // escalate, as recorded (W-5): from an inquiry on a not-received dispute, a note (PayPal: 1–2,000 characters), no
  // amount. Another reason was never escalated in the sandbox: unavailable.
  escalate: (req, snap): ActionRules | null => {
    if (req.action !== 'escalate') return null;
    const r: ActionRules = { stages: RECORDED_STAGES.escalate!, amount: 'not_allowed', text: 'required' };
    const outside = escalateOutsideContract(snap);
    return outside ? { ...r, unavailable: outside } : r;
  },
});

/** The only dispute reason an accept (W-9, W-10) and an escalation (W-5) were recorded on. */
const RECORDED_REASON = 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED';
export const REASON_NOT_VERIFIED = 'not verified with PayPal for this dispute reason';

/** Why an escalation of this dispute is outside what W-5 recorded ([A2]): only the not-received reason. */
export function escalateOutsideContract(snap: DisputeSnapshot): string | null {
  return snap.reason === RECORDED_REASON ? null : REASON_NOT_VERIFIED;
}
export const REFUNDABLE_DIFFERS = "PayPal's refundable amount differs from the dispute amount";

/** Two amounts are the same money: the same currency and the same integer minor units. */
function sameMoney(a: Money | null | undefined, b: Money | null | undefined): boolean {
  if (!a || !b || a.currency !== b.currency) return false;
  try {
    return minorUnits(a.value, a.currency) === minorUnits(b.value, b.currency);
  } catch {
    return false;
  }
}

/**
 * Why an accept of this type on this dispute is outside what the contracts recorded ([A2]), or null: only the
 * not-received reason, and PayPal's refundable amount must be known — for a full accept, equal to the dispute amount
 * (W-10 recorded them equal; PayPal refunds the refundable amount, which the owner must have confirmed).
 */
export function acceptOutsideContract(acceptType: string, snap: DisputeSnapshot): string | null {
  if (snap.reason !== RECORDED_REASON) return REASON_NOT_VERIFIED;
  if (acceptType === 'REFUND' && !sameMoney(snap.allowedRefund, snap.amount)) return REFUNDABLE_DIFFERS;
  if (acceptType === 'PARTIAL_REFUND' && !snap.allowedRefund) return 'PayPal reports no refundable amount for this dispute';
  return null;
}

const requestType = (req: ActionRequest): string | null =>
  req.action === 'send_message' ? (req.attachments.length ? 'file' : null) : req.action === 'accept_claim' ? req.acceptType : req.action === 'make_offer' ? req.offerType : null;

function payloadOf(req: ActionRequest, amount: Money | null): ActionPayload {
  switch (req.action) {
    case 'send_message':
      return { kind: 'send_message', text: req.text };
    case 'escalate':
      // Trimmed like an accept's note: what is approved, hashed, sent and matched against the ESCALATE entry.
      return { kind: 'escalate', note: req.note.trim() };
    case 'accept_claim':
      // Trimmed as the composer and the server's parser trim it: what is approved, hashed, sent and matched.
      return { kind: 'accept_claim', acceptType: req.acceptType, note: req.note.trim(), amount };
    case 'make_offer':
      return { kind: 'make_offer', offerType: req.offerType, note: req.note, amount };
  }
}

const disputeAmountUnknown = (): ComposeProblem => ({ status: 422, error: 'DISPUTE_AMOUNT_UNKNOWN', detail: 'PayPal reports no dispute amount for this dispute: ResolveKit cannot check or show the amount' });

/** The canonical decimal string of an amount (`7` USD → `7.00`); the value as given when it has none. */
function canonicalValue(m: Money): string {
  const r = parseAmount(m.value, m.currency);
  return r.ok ? r.value : m.value;
}

/**
 * Compose an action intent against the dispute as just read. Checks, in this order: availability (link, variant,
 * type allowed now), the contract's stage rule, currency, amount, text. Each action's rules come with its task;
 * without them the action is refused VARIANT_NOT_AVAILABLE.
 */
export interface ComposeActionInput {
  caseId: string;
  req: ActionRequest;
  snap: DisputeSnapshot;
  disputeId: string | null;
  seller: string | null;
  files: SubmissionFile[];
}

export function composeAction(x: ComposeActionInput): IntentContent | ComposeProblem {
  return composeActionWith(x, CONTRACTS, ACTION_RULES);
}

/** {@link composeAction} against a given registry and rules. Internal: for tests with test-only contracts. */
export function composeActionWith(x: ComposeActionInput, contracts: ContractRegistry, rules: Readonly<Partial<Record<SimpleAction, RulesOf>>> = ACTION_RULES): IntentContent | ComposeProblem {
  const { req, snap } = x;
  // 1. Availability, from the fresh read and the registry only.
  if (!snap.allowedActions.includes(req.action)) return { status: 409, error: 'ACTION_NOT_OFFERED', detail: NOT_OFFERED };
  const type = requestType(req);
  const variant = variantOf(req.action, type);
  if (!variant) return { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${type ?? req.action} is not a variant ResolveKit can send` };
  const c = contracts[variant];
  if (c.status === 'not_available') return { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${c.reason ?? 'Contract not recorded yet'}` };
  if (req.action === 'accept_claim' || req.action === 'make_offer') {
    const allowed = (req.action === 'accept_claim' ? snap.responseOptions?.acceptClaimTypes : snap.responseOptions?.offerTypes) ?? [];
    if (!allowed.includes(type ?? '')) return { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: PayPal does not allow ${type} on this dispute right now` };
  }
  const r = rules[req.action]?.(req, snap) ?? null;
  if (!r) return { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: 'Not available: not implemented yet' };
  if (r.unavailable) return { status: 409, error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${r.unavailable}` };

  // 2. Stage.
  if (r.stages && !r.stages.includes(snap.stage ?? '')) {
    return { status: 409, error: 'ACTION_STAGE', detail: `The contract records this action only at stage ${r.stages.join(' or ')}; the dispute is at ${snap.stage ?? 'no stage'}` };
  }

  // 3–4. Currency and amount: exact strings, compared as integer minor units.
  const amount = req.action === 'accept_claim' || req.action === 'make_offer' ? req.amount : null;
  let money: Money | null = null;
  if (amount) {
    if (r.amount === 'not_allowed') return { status: 422, error: 'AMOUNT_NOT_ALLOWED', detail: 'PayPal takes no amount for this action' };
    const d = snap.amount;
    if (!d) return disputeAmountUnknown();
    if (!Object.hasOwn(CURRENCY_EXPONENT, d.currency)) return { status: 422, error: 'UNKNOWN_CURRENCY', detail: `Unknown currency ${d.currency}: ResolveKit cannot check amounts in it` };
    if (amount.currency !== d.currency) return { status: 422, error: 'CURRENCY_MISMATCH', detail: `The amount must be in ${d.currency}, the dispute's currency` };
    let minor: bigint;
    let max: bigint;
    try {
      minor = minorUnits(amount.value, amount.currency);
      max = minorUnits(d.value, d.currency);
    } catch (e) {
      return { status: 422, error: 'INVALID_AMOUNT', detail: (e as Error).message };
    }
    if (minor <= 0n || minor > max || (r.belowDispute && minor >= max)) {
      return { status: 422, error: 'AMOUNT_ABOVE_DISPUTE', detail: `The amount must be more than 0 and ${r.belowDispute ? 'below' : 'at most'} the dispute amount, ${formatMoney(d)}` };
    }
    if (r.belowAmount) {
      let bound: bigint;
      try {
        bound = r.belowAmount.currency === amount.currency ? minorUnits(r.belowAmount.value, r.belowAmount.currency) : -1n;
      } catch {
        bound = -1n;
      }
      if (minor >= bound) return { status: 422, error: 'AMOUNT_ABOVE_REFUNDABLE', detail: `The amount must be below what PayPal would refund, ${formatMoney(r.belowAmount)}` };
    }
    money = { value: canonicalValue(amount), currency: amount.currency };
  } else if (r.amount === 'required') return { status: 422, error: 'AMOUNT_REQUIRED', detail: 'Type the amount' };
  // An accept without an amount refunds the disputed amount: the owner must see it in the terms they confirm.
  else if (req.action === 'accept_claim' && !snap.amount) return disputeAmountUnknown();

  // 5. Text.
  const text = req.action === 'send_message' ? req.text : req.note;
  const name = req.action === 'send_message' ? 'message' : 'note';
  if (r.text === 'required' && !text.trim()) return { status: 422, error: 'TEXT_REQUIRED', detail: `Type the ${name}` };
  if (text.trim().length > ACTION_TEXT_LIMIT) return { status: 422, error: 'TEXT_TOO_LONG', detail: `The ${name} must be at most ${ACTION_TEXT_LIMIT} characters` };

  return {
    caseId: x.caseId,
    disputeId: x.disputeId,
    ...ACTION_EVIDENCE_BLANK,
    files: x.files.map((f) => ({ ...f })),
    action: req.action,
    payload: payloadOf(req, money),
    pin: disputePin(snap, x.disputeId, x.seller),
  };
}

/** What the owner's second confirmation binds ([A3]): any difference means a new intent. */
export interface ConfirmationTerms {
  intentId: string;
  contentHash: string;
  action: IntentAction;
  /** Canonical decimal string; null when the action moves no amount. */
  amount: string | null;
  currency: string | null;
  consequence: string;
}

/** The amount an action moves: the payload's, or for an accept without one, the disputed amount it refunds. */
function termsAmount(c: IntentContent): Money | null {
  const p = c.payload;
  if (p?.kind === 'make_offer') return p.amount;
  if (p?.kind === 'accept_claim') return p.amount ?? c.pin?.amount ?? null;
  return null;
}

/**
 * The terms the owner confirms a second time: every owner action, and a message that repeats one PayPal already
 * recorded (`repeat`). Null for a first-time message and for evidence.
 */
export function confirmationTerms(i: SubmissionIntent, repeat: boolean): ConfirmationTerms | null {
  const action = intentAction(i);
  if (action === 'provide_evidence' || (action === 'send_message' && !repeat)) return null;
  const m = termsAmount(i);
  return {
    intentId: i.id,
    contentHash: i.contentHash,
    action,
    amount: m ? canonicalValue(m) : null,
    currency: m ? m.currency : null,
    consequence: consequenceCode(i),
  };
}

/** The consequence code an intent is confirmed with: a partial accept is an offer, never REFUNDS_BUYER. */
function consequenceCode(c: IntentContent): string {
  const action = intentAction(c);
  if (action === 'send_message') return REPEATS_MESSAGE;
  if (isPartialAccept(c)) return OFFERS_PARTIAL_REFUND;
  return CONSEQUENCE[action as Exclude<IntentAction, 'provide_evidence'>];
}

const TERM_KEYS: readonly (keyof ConfirmationTerms)[] = ['intentId', 'contentHash', 'action', 'amount', 'currency', 'consequence'];

/** The terms the client echoes are exactly these: the same fields, each strictly equal (the amount as its canonical string). */
export function sameTerms(a: ConfirmationTerms, b: unknown): boolean {
  if (!isRecord(b)) return false;
  return Object.keys(b).length === TERM_KEYS.length && TERM_KEYS.every((k) => Object.hasOwn(b, k) && b[k] === a[k]);
}

/** What an escalation does at PayPal (W-5): the inquiry becomes a claim; what follows is what PayPal offers there. */
export const ESCALATE_CONSEQUENCE = 'The inquiry becomes a claim decided by PayPal. Inquiry actions end; what you can do next is what PayPal offers on the claim.';

/** What happens at PayPal when the action is sent, in plain words for the confirmation (refined by each action's task). */
export function consequenceText(c: IntentContent): string {
  const m = termsAmount(c);
  const amount = m ? formatMoney(m) : 'the disputed amount';
  switch (intentAction(c)) {
    case 'send_message':
      return 'The buyer sees this message in PayPal.';
    case 'accept_claim':
      return acceptConsequenceText(c.payload?.kind === 'accept_claim' ? c.payload.acceptType : 'REFUND', m);
    case 'escalate':
      return ESCALATE_CONSEQUENCE;
    case 'make_offer':
      return `The buyer is offered ${amount}.`;
    case 'appeal':
      return 'PayPal reviews its decision again with this appeal.';
    case 'provide_evidence':
      return 'PayPal receives this evidence for the dispute.';
  }
}

/**
 * What an accept does at PayPal, by its type, with the amount it moves (a full accept: the disputed amount; a partial
 * one: the amount offered). A partial accept is an offer the buyer must agree to (W-9), never a refund or a closure.
 */
export function acceptConsequenceText(acceptType: string, amount: Money | null): string {
  const a = amount ? formatMoney(amount) : 'the disputed amount';
  if (acceptType === 'PARTIAL_REFUND') {
    return `PayPal offers the buyer a partial refund of ${amount ? a : 'the amount you set'}. The buyer has to agree to it: unless they accept, no money moves and the dispute stays open.`;
  }
  return `PayPal refunds ${a} to the buyer and closes the dispute in the buyer’s favour. This cannot be undone.`;
}

/** The action of an intent or a request in a few words, telling a full accept from a partial one (titles, audit). */
export function actionTitle(x: { action?: IntentAction; payload?: ActionPayload } | ActionRequest): string {
  const action = x.action ?? 'provide_evidence';
  const acceptType = 'acceptType' in x ? x.acceptType : 'payload' in x && x.payload?.kind === 'accept_claim' ? x.payload.acceptType : null;
  switch (action) {
    case 'send_message':
      return 'Send message';
    case 'accept_claim':
      return acceptType === 'PARTIAL_REFUND' ? 'Accept claim · partial refund offer' : 'Accept claim · full refund';
    case 'escalate':
      return 'Escalate';
    case 'make_offer':
      return 'Make offer';
    case 'appeal':
      return 'Appeal';
    case 'provide_evidence':
      return 'Provide evidence';
  }
}

/** A thread message's key: who, when and how long. No text, so it can be kept with an approval. */
export const messageKey = (m: DisputeMessage): string => `${m.postedBy}|${m.time ?? ''}|${m.content.length}`;

/** Actions a new buyer message holds ([A5]): the merchant may be answering an outdated message. */
const HELD_BY_BUYER_MESSAGE: readonly IntentAction[] = ['send_message', 'make_offer', 'accept_claim'];

/**
 * The buyer messages PayPal shows now that were not there at approval (`keysAtApproval`, by {@link messageKey}), for
 * an action they hold. Empty for escalate and appeal (shown, not blocking) and for evidence. The merchant's own
 * messages, the read time, the link order and fields outside the hash never count.
 */
export function relevantNewBuyerMessages(action: IntentAction, keysAtApproval: readonly string[], fresh: DisputeSnapshot): DisputeMessage[] {
  if (!HELD_BY_BUYER_MESSAGE.includes(action)) return [];
  return unseen(fresh.messages ?? [], messageKey, keysAtApproval).filter((m) => m.postedBy === 'BUYER');
}

/**
 * The items not in a baseline, compared as a multiset: each baseline key absorbs one item with that key, so a second
 * item with the same key (e.g. two untimed messages of the same length) is new.
 */
export function unseen<T>(items: readonly T[], key: (t: T) => string, baseline: readonly string[]): T[] {
  const left = new Map<string, number>();
  for (const k of baseline) left.set(k, (left.get(k) ?? 0) + 1);
  return items.filter((t) => {
    const k = key(t);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    return n === 0;
  });
}
