/**
 * The dispute actions other than evidence (B0): the same chain as evidence, for every action.
 *
 *   POST /api/disputes/:case/intent {action, …}                 → 201: composed here against a fresh PayPal read
 *   POST /api/disputes/:case/intent/:id/approve {contentHash}   → 200, with the second-confirmation terms (or null)
 *   POST /api/disputes/:case/intent/:id/confirm {terms}         → 200 when the terms are exactly this intent's ([A3])
 *   POST /api/disputes/:case/intent/:id/acknowledge {contentHash} → 200: new buyer messages seen, same content ([A5])
 *   POST /api/disputes/:case/send {intentId}                    → 202 sent (or 'unknown'), or 200 reconciled
 *   GET  /api/disputes/:case/intent/:id/readback                → 200 { readBack, snapshot }: what PayPal proves ([A4])
 *
 * What can be done is always rebuilt from a fresh PayPal read; local state only prevents duplicates and conflicting
 * writes ([A1]). The role is checked at compose, approve, confirm and send: hidden buttons are not a control.
 */
import type { Dispute, EvidenceFile, PayPalClient } from '@resolvekit/paypal';
import { PayPalError } from '@resolvekit/paypal';
import { CONTRACTS } from '../../../web/src/domain/actionContracts.ts';
import {
  ACTION_RULES,
  OWNER_ACTIONS,
  REPEATS_MESSAGE,
  composeActionWith,
  confirmationTerms,
  duplicateKey,
  intentAction,
  isSimpleAction,
  messageKey,
  parseActionRequest,
  relevantNewBuyerMessages,
  sameTerms,
  type ActionRequest,
  type ConfirmationTerms,
  type ContractRegistry,
  type IntentAction,
  type RulesOf,
  type SimpleAction,
} from '../../../web/src/domain/actions.ts';
import { proveSend, readBackBase, type ReadBackBase } from '../../../web/src/domain/actionReadback.ts';
import { contentHash, isComposeProblem } from '../../../web/src/domain/intent.ts';
import type { DisputeSnapshot, SubmissionFile } from '../../../web/src/domain/types.ts';
import type { ActingPerson, Actor, CaseState, CostlyAction, Reservation } from '../app.ts';
import { publicIntent, type IntentStore, type StoredIntent } from '../intents.ts';
import { callPayPal, capOf, contractOf, isAmbiguous, sendProblem } from './calls.ts';

export interface ActionRouteDeps {
  intents: IntentStore;
  /** The case right now: a bound case read fresh from PayPal with its binding verified (app.ts), or a Response. */
  caseState: (caseId: string, req: Request) => Promise<CaseState | Response>;
  /** Hosted: refuses a person who does not act for the seller on the dispute as just read. */
  sellerRefusal: (req: Request, st: Pick<CaseState, 'dispute'>) => Response | null;
  actorOf: (req: Request, unlocked: boolean) => Actor;
  personOf: (req: Request) => ActingPerson | null;
  /** The bytes of confirmed uploads of the case's active dispute, by id (a message's attachment). */
  uploadFiles: (caseId: string, st: CaseState, ids: readonly string[]) => Promise<Array<{ file: SubmissionFile; data: EvidenceFile }> | Response>;
  /** An appeal composed again from the analysis, as evidence is before its send (Task 12). */
  recomposeEvidence: (caseId: string, st: CaseState, i: StoredIntent) => Promise<{ contentHash: string; attachments: EvidenceFile[] } | Response>;
  /** Hosted: the daily caps (message, settle). Null: no gate (local). */
  reserve: ((req: Request, action: CostlyAction) => Reservation) | null;
  snapshotOf: (caseId: string, d: Dispute) => Promise<DisputeSnapshot>;
  paypal: PayPalClient | null;
  log: (line: string) => void;
  now: () => Date;
  /** Test only: a registry and rules with test-only contracts (production uses CONTRACTS and ACTION_RULES). */
  contracts?: ContractRegistry;
  rules?: Readonly<Partial<Record<SimpleAction, RulesOf>>>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HASH = /^[0-9a-f]{64}$/;
const PENDING = 'Outcome pending confirmation';
const OWNER_ONLY = 'Only the workspace owner can do this action: it moves money or changes the dispute at PayPal';
const UNKNOWN_INTENT = { error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case and session' };

const sellerOf = (d: Dispute | null): string | null => d?.disputed_transactions?.[0]?.seller?.merchant_id ?? null;
/** The buyer messages of a read, by key (no text): what an approval is held against ([A5]). */
const buyerKeys = (s: DisputeSnapshot): string[] => (s.messages ?? []).filter((m) => m.postedBy === 'BUYER').map(messageKey);
const isActionIntent = (i: StoredIntent) => intentAction(i) !== 'provide_evidence';

/** PayPal's issue code (details[].issue), if it gave one. */
function issueOf(e: unknown): string | undefined {
  if (!(e instanceof PayPalError)) return undefined;
  const b = e.body as { details?: Array<{ issue?: string }> } | null;
  return b?.details?.find((d) => d.issue)?.issue ?? undefined;
}
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
/** A short reason for the trail: codes and PayPal's debug_id, never message text. */
function failureText(e: unknown): string {
  if (e instanceof PayPalError) return `PayPal ${e.status}${issueOf(e) ? ` ${issueOf(e)}` : ''}${e.debugId ? ` · debug_id ${e.debugId}` : ''}`;
  return isTimeout(e) ? 'PayPal timed out' : 'PayPal unreachable';
}
/** A failed read of PayPal as an API answer. */
function readFailure(e: unknown): Response {
  if (e instanceof PayPalError) return json(e.status === 404 ? 404 : 502, { error: 'PAYPAL_READ_FAILED', detail: failureText(e), paypalStatus: e.status, debugId: e.debugId ?? undefined });
  return json(isTimeout(e) ? 504 : 502, { error: isTimeout(e) ? 'PAYPAL_TIMEOUT' : 'PAYPAL_UNREACHABLE' });
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, res: json(400, { error: 'INVALID_JSON' }) };
  }
}

/** The body is exactly `{ <key>: … }`. */
const only = (body: unknown, key: string): body is Record<string, unknown> => isRecord(body) && Object.keys(body).length === 1 && Object.hasOwn(body, key);

export interface ActionRoutes {
  compose: (req: Request, caseId: string) => Promise<Response>;
  confirm: (req: Request, caseId: string, intentId: string) => Promise<Response>;
  acknowledge: (req: Request, caseId: string, intentId: string) => Promise<Response>;
  send: (req: Request, caseId: string, boundId: string) => Promise<Response>;
  readBack: (req: Request, caseId: string, intentId: string) => Promise<Response>;
  /** 403 OWNER_ONLY unless the person is the workspace owner (not a reviewer), for owner-only actions. */
  ownerRefusal: (req: Request, action: IntentAction) => Response | null;
  /** The second-confirmation terms of an intent now (a message repeats one PayPal recorded: REPEATS_MESSAGE). */
  termsOf: (i: StoredIntent) => ConfirmationTerms | null;
}

export function createActionRoutes(deps: ActionRouteDeps): ActionRoutes {
  const { intents, log, now } = deps;
  const contracts = deps.contracts ?? CONTRACTS;
  const rules = deps.rules ?? ACTION_RULES;

  const ownerRefusal = (req: Request, action: IntentAction): Response | null => {
    if (!OWNER_ACTIONS.includes(action)) return null;
    const p = deps.personOf(req);
    if (p && p.role === 'owner' && !p.reviewer) return null;
    return json(403, { error: 'OWNER_ONLY', detail: OWNER_ONLY, action });
  };
  /** PayPal already recorded this exact action (same content, same stage) on this dispute. */
  const repeats = (i: StoredIntent): boolean => {
    const key = duplicateKey(i);
    return !!key && !!i.disputeId && intents.recordedDuplicate(i.disputeId, key);
  };
  const termsOf = (i: StoredIntent): ConfirmationTerms | null => confirmationTerms(i, repeats(i));
  /** The person confirmed exactly these terms (code and amount); the intent id and hash are its own. */
  const confirmedFor = (i: StoredIntent, t: ConfirmationTerms): boolean => {
    const c = i.confirmation;
    if (!c || c.code !== t.consequence) return false;
    return (c.amount?.value ?? null) === t.amount && (c.amount?.currency ?? null) === t.currency;
  };
  /** The caller's own action intent of this case, or the answer to give. */
  const ownAction = (actor: string, caseId: string, intentId: string): StoredIntent | Response => {
    const i = intents.get(intentId, actor);
    if (!i || i.caseId !== caseId) return json(404, UNKNOWN_INTENT);
    if (!isActionIntent(i)) return json(409, { error: 'WRONG_SEND_ROUTE', detail: 'This intent is an evidence response; it is approved and sent as evidence' });
    return i;
  };

  /** Compose an action against the dispute as just read: the exact content, hashed with the dispute's pin. */
  const compose = async (req: Request, caseId: string): Promise<Response> => {
    const who = deps.actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const ar = parseActionRequest(parsed.body);
    if (isComposeProblem(ar)) return json(ar.status, { error: ar.error, detail: ar.detail });
    const notOwner = ownerRefusal(req, ar.action);
    if (notOwner) return notOwner;
    // Caps before the PayPal read; nothing changes when refused.
    const full = intents.admit(caseId, who.actor, who.client ?? 'local');
    if (full) return tooMany(full);
    const st = await deps.caseState(caseId, req);
    if (st instanceof Response) return st;
    if (!st.snap || !st.disputeId) return json(409, { error: 'SIMULATED_CASE', detail: 'This case runs on the simulator: its actions are played in the browser, never sent to PayPal' });
    const notSeller = deps.sellerRefusal(req, st);
    if (notSeller) return notSeller;
    const built = ar.action === 'send_message' && ar.attachments.length ? await deps.uploadFiles(caseId, st, ar.attachments) : [];
    if (built instanceof Response) return built;
    const content = composeActionWith({ caseId, req: ar, snap: st.snap, disputeId: st.disputeId, seller: sellerOf(st.dispute), files: built.map((b) => b.file) }, contracts, rules);
    if (isComposeProblem(content)) return json(content.status, { error: content.error, detail: content.detail });
    const hash = await contentHash(content);
    const intent = intents.create({
      ...content,
      contentHash: hash,
      request: ar,
      rechecks: {},
      createdBy: who.actor,
      createdFrom: who.client ?? 'local',
      team: who.team ?? null,
      inputUploads: [],
      // The thread as the merchant saw it when composing: a buyer message after this holds the send ([A5]).
      threadKeysAtApproval: buyerKeys(st.snap),
    });
    if ('ok' in intent) return tooMany(intent);
    return json(201, { ...publicIntent(intent), repeat: repeats(intent) });
  };

  /** POST …/confirm {terms}: the owner's second confirmation, exactly the terms the server issued for this intent. */
  const confirm = async (req: Request, caseId: string, intentId: string): Promise<Response> => {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    if (!only(parsed.body, 'terms')) return json(400, { error: 'INVALID_CONFIRMATION', detail: 'The body must be { "terms": <the terms the approval returned> }' });
    const who = deps.actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const i = ownAction(who.actor, caseId, intentId);
    if (i instanceof Response) return i;
    const notOwner = ownerRefusal(req, intentAction(i));
    if (notOwner) return notOwner;
    const terms = termsOf(i);
    if (!terms) return json(409, { error: 'NO_CONFIRMATION', detail: 'This intent needs no second confirmation' });
    if (!sameTerms(terms, parsed.body.terms)) return json(409, { error: 'CONFIRMATION_MISMATCH', detail: 'These terms are not the ones of this intent; compose it again' });
    const t = intents.confirm(intentId, caseId, who.actor, { code: terms.consequence, amount: terms.amount && terms.currency ? { value: terms.amount, currency: terms.currency } : null });
    if (!t.ok) return json(t.status, { error: t.error, detail: t.detail, ...(t.intent ? { intent: publicIntent(t.intent) } : {}) });
    return json(200, { ...publicIntent(t.intent), confirmation: terms });
  };

  /** POST …/acknowledge {contentHash}: the new buyer messages were seen; the same content goes on, against a new read. */
  const acknowledge = async (req: Request, caseId: string, intentId: string): Promise<Response> => {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const hash = only(parsed.body, 'contentHash') ? parsed.body.contentHash : undefined;
    if (typeof hash !== 'string' || !HASH.test(hash)) return json(400, { error: 'INVALID_ACKNOWLEDGEMENT', detail: 'The body must be { "contentHash": "<the content you reviewed>" }' });
    const who = deps.actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const i = ownAction(who.actor, caseId, intentId);
    if (i instanceof Response) return i;
    const notOwner = ownerRefusal(req, intentAction(i));
    if (notOwner) return notOwner;
    if (hash !== i.contentHash) return json(409, { error: 'CONTENT_HASH_MISMATCH', detail: 'The acknowledged content is not the content of this intent' });
    if (i.status !== 'approved' && i.status !== 'failed') return json(409, { error: `INTENT_${i.status.toUpperCase()}`, detail: `This intent is ${i.status}`, intent: publicIntent(i) });
    const st = await deps.caseState(caseId, req);
    if (st instanceof Response) return st;
    if (!st.snap || st.disputeId !== i.disputeId) return json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${i.disputeId ?? 'the simulator'}; the case is bound to ${st.disputeId ?? 'the simulator'} now` });
    const notSeller = deps.sellerRefusal(req, st);
    if (notSeller) return notSeller;
    const t = intents.acknowledge(intentId, caseId, who.actor, buyerKeys(st.snap));
    if (!t.ok) return json(t.status, { error: t.error, detail: t.detail });
    return json(200, { ...publicIntent(t.intent), snapshot: st.snap });
  };

  /**
   * POST /api/disputes/:case/send {intentId}. The order is fixed: body, ownership, action family and role, binding;
   * the in-flight and uncertain locks; the cap and a fresh read; reconcile an uncertain send first; the re-checks
   * (compose again, duplicates, new buyer messages, second confirmation); the read-back base and send_started on disk;
   * then the one POST.
   */
  const send = async (req: Request, caseId: string, boundId: string): Promise<Response> => {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;
    if (!only(body, 'intentId') || typeof body.intentId !== 'string') {
      return json(400, { error: 'INVALID_SUBMISSION', detail: 'The body must be { "intentId": "<approved intent>" }: what is sent is composed and approved on the server, never taken from the request' });
    }
    const intentId = body.intentId;
    const who = deps.actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    // 1. Ownership, action family, role, binding.
    const i0 = intents.get(intentId, who.actor);
    if (!i0 || i0.caseId !== caseId) return json(404, UNKNOWN_INTENT);
    if (!isActionIntent(i0)) return json(409, { error: 'WRONG_SEND_ROUTE', detail: 'This intent is an evidence response; send it from the evidence route' });
    const action = intentAction(i0);
    const notOwner = ownerRefusal(req, action);
    if (notOwner) return notOwner;
    if (!i0.disputeId) return json(409, { error: 'SIMULATED_CASE', detail: 'This intent is for the simulator; it is never sent to PayPal' });
    if (i0.disputeId !== boundId) {
      intents.invalidate(intentId, 'the case is bound to another dispute now', who.actor);
      return json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${i0.disputeId}; the case is bound to ${boundId} now` });
    }
    const paypal = deps.paypal;
    if (!paypal) return json(503, { error: 'PAYPAL_UNCONFIGURED' });

    // 2. In flight and uncertain: the holder of an uncertain dispute may go on only to be reconciled first.
    let claim = intents.beginSend(intentId, caseId, who.actor, { reconcile: true });
    if (!claim.ok) return json(claim.status, { error: claim.error, detail: claim.detail, ...(claim.intent ? { intent: publicIntent(claim.intent) } : {}) });
    const intent = claim.intent;
    const reconciling = intents.isUncertain(boundId)?.intentId === intentId;
    const refuse = (res: Response, why: string, invalidate: boolean): Response => {
      if (invalidate) intents.invalidate(intentId, why, who.actor);
      else intents.revert(intentId, claim.ok ? claim.previous : 'approved');
      intents.record({ caseId, kind: 'send_refused', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId, detail: why });
      return res;
    };

    // 3. The daily cap, then a fresh read. send_started's time is taken before that read: a PayPal entry timed after it
    // can only be this send's (clock-skew safety, [A4]).
    const reserved = deps.reserve?.(req, capOf(action));
    if (reserved && !reserved.ok) return refuse(json(reserved.refusal.status, reserved.refusal.body), String((reserved.refusal.body as { error?: string }).error ?? reserved.refusal.status), false);
    let sending = false;
    try {
      const sentStartedAt = now().toISOString();
      const st = await deps.caseState(caseId, req);
      if (st instanceof Response) {
        const b = (await st.clone().json().catch(() => ({}))) as { error?: string };
        return refuse(st, b.error ?? `refused (${st.status})`, b.error === 'BINDING_INVALID');
      }
      if (!st.dispute || !st.snap) return refuse(json(409, { error: 'NOT_BOUND', detail: 'PayPal is not connected for this case now' }), 'PayPal not connected', false);
      if (st.disputeId !== boundId) {
        return refuse(json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${boundId}; the case is bound to ${st.disputeId} now` }), 'the case moved to another dispute', true);
      }
      const notSeller = deps.sellerRefusal(req, st);
      if (notSeller) return refuse(notSeller, 'not the seller on this dispute', true);
      const snap = st.snap;
      const contract = contractOf(intent, contracts);

      // 4. An uncertain send of this intent: read back first. Recorded → done, no POST; pending → nothing is sent;
      // absent (and still offered) → the same intent, the same PayPal-Request-Id.
      if (reconciling) {
        const base = intent.readBackBase ?? null;
        const r = contract && base ? proveSend(intent, base, snap, contract, now().getTime()) : { state: 'pending' as const, detail: PENDING };
        intents.revert(intentId, claim.previous);
        const durable = intents.recordReadBack(intentId, r);
        if (r.state === 'recorded') {
          if (!durable) return json(503, { error: 'AUDIT_UNAVAILABLE', detail: 'PayPal shows this action, but that could not be recorded durably; check again', readBack: { ...r, at: now().toISOString() } });
          log(`action reconciled · case ${caseId} → ${boundId} · ${action} · intent ${intentId}: recorded by PayPal, not sent again`);
          return json(200, { reconciled: true, intent: publicIntent(intents.get(intentId, who.actor)!), readBack: { ...r, at: now().toISOString() } });
        }
        if (r.state === 'pending' || !durable) {
          // A pending read-back holds the dispute whatever the disk says (fail-closed); an absence not recorded durably
          // changed nothing: still held.
          intents.record({ caseId, kind: 'send_refused', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId, detail: 'outcome still unproven' });
          return json(409, { error: 'DISPUTE_UNCERTAIN', detail: `${PENDING}: PayPal does not show this send yet, and does not prove it absent; nothing was sent again`, intent: publicIntent(intents.get(intentId, who.actor)!) });
        }
        // Proven absent: the dispute is free; claim it again for this send (synchronously, nothing in between).
        claim = intents.beginSend(intentId, caseId, who.actor);
        if (!claim.ok) return json(claim.status, { error: claim.error, detail: claim.detail, ...(claim.intent ? { intent: publicIntent(claim.intent) } : {}) });
      }

      // 5. Compose again on the fresh read: availability, stage, amount, text and the pin must give the approved hash.
      let files: EvidenceFile[] = [];
      if (action === 'appeal') {
        const again = await deps.recomposeEvidence(caseId, st, intent);
        if (again instanceof Response) {
          const b = (await again.clone().json().catch(() => ({}))) as { error?: string };
          return refuse(again, `composing again failed: ${b.error ?? again.status}`, again.status !== 503 && again.status !== 502);
        }
        if (again.contentHash !== intent.contentHash) return refuse(stale(), 'content changed', true);
        files = again.attachments;
      } else {
        const ar = intent.request as ActionRequest;
        if (!isSimpleAction(ar.action)) return refuse(stale(), 'not an action request', true);
        const built = ar.action === 'send_message' && ar.attachments.length ? await deps.uploadFiles(caseId, st, ar.attachments) : [];
        if (built instanceof Response) {
          const b = (await built.clone().json().catch(() => ({}))) as { error?: string };
          return refuse(built, `attachment refused: ${b.error ?? built.status}`, built.status !== 503 && built.status !== 502);
        }
        const again = composeActionWith({ caseId, req: ar, snap, disputeId: st.disputeId, seller: sellerOf(st.dispute), files: built.map((b) => b.file) }, contracts, rules);
        if (isComposeProblem(again)) return refuse(json(again.status, { error: again.error, detail: again.detail }), `composing again failed: ${again.error}`, again.status < 500);
        if ((await contentHash(again)) !== intent.contentHash) return refuse(stale(), 'content changed', true);
        files = built.map((b) => b.data);
      }

      // 6. The same action, content and stage PayPal already recorded: only a message confirmed as a repeat goes.
      const key = duplicateKey(intent);
      if (key && intents.recordedDuplicate(boundId, key) && intent.confirmation?.code !== REPEATS_MESSAGE) {
        return refuse(json(409, { error: 'DUPLICATE_ACTION', detail: 'PayPal already recorded this exact action on this dispute; confirm it as a repeat or compose another' }), 'duplicate of a recorded action', false);
      }
      // 7. A buyer message after approval: the merchant may be answering an outdated message ([A5]).
      const fresh = relevantNewBuyerMessages(action, intent.threadKeysAtApproval ?? [], snap);
      if (fresh.length) {
        return refuse(json(409, { error: 'NEEDS_REVIEW', detail: 'The buyer wrote since you approved this; read it, then send the same content or edit it', messages: fresh }), 'new buyer message', false);
      }
      // 8. The owner's second confirmation, bound to this intent ([A3]).
      const terms = termsOf(intent);
      if (terms && !confirmedFor(intent, terms)) {
        return refuse(json(409, { error: 'CONFIRMATION_REQUIRED', detail: 'Confirm the consequence of this action first', terms }), 'confirmation required', false);
      }
      const unsendable = sendProblem(intent, files, contracts);
      if (unsendable) return refuse(json(409, { error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${unsendable}` }), unsendable, true);

      // 9. The read-back base, then send_started, on disk before PayPal is called. Either fails: nothing is sent.
      const base: ReadBackBase = contract?.proof ? readBackBase(snap, contract.proof, sentStartedAt) : { entryKeys: [], stage: snap.stage ?? null, status: snap.status, sentStartedAt };
      const unavailable = () => json(503, { error: 'AUDIT_UNAVAILABLE', detail: 'The send could not be recorded durably, so nothing was sent; try again later' });
      if (!intents.setReadBackBase(intentId, base)) {
        log(`AUDIT UNAVAILABLE: read-back base not written · case ${caseId} · intent ${intentId}; nothing sent`);
        return refuse(unavailable(), 'audit log unavailable', false);
      }
      const stage = snap.stage ?? null;
      const started = intents.recordChecked({ caseId, kind: 'send_started', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId, stage });
      if (!started.durable) {
        log(`AUDIT UNAVAILABLE: send_started not written · case ${caseId} · intent ${intentId}; nothing sent`);
        return refuse(unavailable(), 'audit log unavailable', false);
      }

      // 10. The one POST. A known refusal frees the dispute; anything unclear holds it until a read-back says.
      sending = true;
      try {
        await callPayPal(paypal, boundId, intent, files, intent.requestId, contracts);
      } catch (e) {
        if (!isAmbiguous(e)) {
          intents.failed(intentId, who.actor, failureText(e), 'refused');
          const pe = e as PayPalError;
          return json(422, { error: 'PAYPAL_REFUSED', detail: pe.message, paypalIssue: issueOf(e), paypalStatus: pe.status, debugId: pe.debugId ?? undefined });
        }
        intents.failed(intentId, who.actor, failureText(e), 'ambiguous');
        log(`action outcome unknown · case ${caseId} → ${boundId} · ${action} · intent ${intentId} · request ${intent.requestId} · ${failureText(e)}`);
        return json(202, { sent: 'unknown', detail: PENDING, intent: publicIntent(intents.get(intentId, who.actor)!) });
      }
      if (!intents.sent(intentId, who.actor, 'accepted by PayPal (read back to confirm)', stage)) {
        log(`AUDIT NOT DURABLE: outcome of intent ${intentId} (case ${caseId} -> ${boundId}) not written; PayPal accepted it`);
      }
      // Accepted is not recorded: held until a read-back proves it ([A4]).
      intents.markUncertain(intentId, 'awaiting proof');
      log(`action sent · case ${caseId} → ${boundId} · ${action} · intent ${intentId} · request ${intent.requestId}`);
      return json(202, { sent: true, intent: publicIntent(intents.get(intentId, who.actor)!) });
    } catch (e) {
      if (!sending) intents.revert(intentId, claim.ok ? claim.previous : 'approved');
      throw e;
    } finally {
      if (!sending && reserved?.ok) reserved.release();
    }
  };

  /**
   * GET …/intent/:id/readback: the pinned dispute read now, and what it proves about this intent's send. Only the
   * intent that holds its dispute is settled here; never while its POST has not answered.
   */
  const readBack = async (req: Request, caseId: string, intentId: string): Promise<Response> => {
    const who = deps.actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const i = ownAction(who.actor, caseId, intentId);
    if (i instanceof Response) return i;
    if (!i.disputeId) return json(409, { error: 'SIMULATED_CASE', detail: 'This intent is for the simulator; the simulator reads it back' });
    if (i.status === 'sending') return json(409, { error: 'INTENT_SENDING', detail: 'This intent is being sent right now; read it back once PayPal answers' });
    const holder = intents.isUncertain(i.disputeId)?.intentId === intentId;
    if (!holder && i.readBack !== 'recorded') return json(409, { error: 'INTENT_NOT_SENT', detail: 'This intent has no send to read back' });
    const paypal = deps.paypal;
    if (!paypal) return json(503, { error: 'PAYPAL_UNCONFIGURED' });
    // The send this read is about: a retry that started meanwhile has its own base, and this read predates it.
    const baseAt = i.readBackBase?.sentStartedAt ?? null;
    let d: Dispute;
    try {
      d = await paypal.disputes.get(i.disputeId);
    } catch (e) {
      return readFailure(e);
    }
    const notSeller = deps.sellerRefusal(req, { dispute: d });
    if (notSeller) return notSeller;
    const snapshot = await deps.snapshotOf(caseId, d);
    const at = now().toISOString();
    // The read may have been answered after another request settled it: the state as it is now.
    const current = intents.get(intentId, who.actor) ?? i;
    if (current.status === 'sending') return json(409, { error: 'INTENT_SENDING', detail: 'This intent is being sent right now; read it back once PayPal answers' });
    if (holder && (current.readBackBase?.sentStartedAt ?? null) !== baseAt) {
      return json(200, { readBack: { state: 'pending', detail: PENDING, at }, snapshot, intent: publicIntent(current) });
    }
    if (!holder || intents.isUncertain(i.disputeId)?.intentId !== intentId) {
      const state = current.readBack === 'recorded' ? 'recorded' : current.readBack === 'absent' ? 'absent' : 'pending';
      return json(200, { readBack: { state, detail: state === 'recorded' ? 'Recorded by PayPal' : state === 'absent' ? 'PayPal shows no trace of this send' : PENDING, at }, snapshot, intent: publicIntent(current) });
    }
    const contract = contractOf(current, contracts);
    const base = current.readBackBase ?? null;
    const r = contract && base ? proveSend(current, base, snapshot, contract, now().getTime()) : { state: 'pending' as const, detail: PENDING };
    const durable = intents.recordReadBack(intentId, r);
    if (!durable && r.state !== 'pending') {
      // Nothing changed: the dispute stays held until a read-back is recorded durably.
      return json(503, { error: 'AUDIT_UNAVAILABLE', detail: 'PayPal’s answer could not be recorded durably; check again', readBack: { state: 'pending', detail: PENDING, at }, snapshot });
    }
    // A pending read-back holds the dispute even when its line is not durable (fail-closed).
    if (!durable) log(`AUDIT NOT DURABLE: read-back of intent ${intentId} (pending) not written; the dispute stays held`);
    return json(200, { readBack: { ...r, at }, snapshot, intent: publicIntent(intents.get(intentId, who.actor) ?? current) });
  };

  return { compose, confirm, acknowledge, send, readBack, ownerRefusal, termsOf };
}

function stale(): Response {
  return json(409, { error: 'INTENT_STALE', detail: 'What would be sent now differs from what you approved (the dispute’s stage, status, amount or the content changed); compose it again' });
}

function tooMany(x: { status: number; error: string; detail: string; retryAfterSec?: number }): Response {
  const r = json(x.status, { error: x.error, detail: x.detail, ...(x.retryAfterSec ? { retryAfterSec: x.retryAfterSec } : {}) });
  if (x.retryAfterSec) r.headers.set('retry-after', String(x.retryAfterSec));
  return r;
}
