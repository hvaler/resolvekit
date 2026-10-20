/**
 * Read-back proof of an action send ([A4]). «Recorded by PayPal» needs an entry attributable to this send: new
 * against the read taken before the POST, by the contract's actor, timed at or after `send_started`, and equal to the
 * approved content under exactly the normalisation the contract records. A state change alone (status, stage, links)
 * can come from another actor and proves nothing. Pure: the server and the in-browser simulator use the same matcher.
 *
 * Proof fields are named as PayPal names them (dotted paths, e.g. `posted_by`, `action_info.action`); the snapshot's
 * mapped lists are read back under those names, and a field the snapshot does not carry is null, so it never matches.
 */
import { variantOf, type ProofFields, type VariantContract, type VariantId } from './actionContracts.ts';
import { intentAction, messageKey, unseen } from './actions.ts';
import type { IntentContent } from './intent.ts';
import { evidenceKey } from './recorded.ts';
import type { DisputeSnapshot } from './types';

/** What the read before the POST showed: the proof list's entries by the contract's actor (keys only, no text). */
export interface ReadBackBase {
  entryKeys: string[];
  stage: string | null;
  status: string;
  sentStartedAt: string;
}

export type ProofState = 'recorded' | 'absent' | 'pending';

export interface ReadBackRecord {
  state: ProofState;
  detail: string;
  at: string;
}

interface Entry {
  key: string;
  fields: Readonly<Record<string, string | null>>;
}

/** The entries of a proof list in a snapshot, each with its key and its fields under PayPal's names. */
function entriesOf(s: DisputeSnapshot, list: NonNullable<ProofFields['list']>): Entry[] {
  switch (list) {
    case 'messages':
      return (s.messages ?? []).map((m) => ({ key: messageKey(m), fields: { posted_by: m.postedBy, time_posted: m.time, content: m.content } }));
    case 'evidences':
      return s.evidences.map((e) => ({
        key: evidenceKey(e),
        fields: { source: e.source, date: e.date ?? null, notes: e.notes, evidence_type: e.evidenceType, 'action_info.action': e.action ?? null },
      }));
    case 'offerHistory':
      return (s.offerHistory ?? []).map((o) => {
        const fields = { actor: o.actor, offer_time: o.time, event_type: o.event, offer_type: o.type, 'offer_amount.value': o.amount?.value ?? null, 'offer_amount.currency_code': o.amount?.currency ?? null };
        return { key: JSON.stringify(Object.values(fields)), fields };
      });
    default:
      // A list the snapshot does not map: its entries come already reduced to the contracts' proof fields.
      return (s.proofEntries ?? []).map((e) => ({ key: JSON.stringify(Object.keys(e).sort().map((k) => [k, e[k]])), fields: e }));
  }
}

const value = (e: Entry, path: string): string | null => e.fields[path] ?? null;

/** The entries of the contract's actor (e.g. the seller's messages). */
function actorEntries(s: DisputeSnapshot, proof: ProofFields): Entry[] {
  if (!proof.list || !proof.actorField || !proof.actorValue) return [];
  return entriesOf(s, proof.list).filter((e) => value(e, proof.actorField!) === proof.actorValue);
}

/** The base a read-back compares with, from the read taken right before the POST. */
export function readBackBase(s: DisputeSnapshot, proof: ProofFields, sentStartedAt: string): ReadBackBase {
  return { entryKeys: actorEntries(s, proof).map((e) => e.key), stage: s.stage ?? null, status: s.status, sentStartedAt };
}

/** The approved value a proof field must equal, by PayPal's field name; undefined when this content has none. */
function approvedValue(c: IntentContent, field: string): string | undefined {
  const p = c.payload;
  if (!p) return undefined;
  switch (p.kind) {
    case 'send_message':
      return field === 'content' ? p.text : undefined;
    case 'escalate':
      return field === 'notes' ? p.note : undefined;
    case 'accept_claim':
      // Seen in reads/resolved-GFC.json: the accept entry carries action_info { action, response_option } and notes.
      return ({ notes: p.note, 'action_info.action': 'ACCEPT_CLAIM', 'action_info.response_option': p.acceptType } as Record<string, string>)[field];
    case 'make_offer':
      return ({ notes: p.note, offer_type: p.offerType, 'offer_amount.value': p.amount?.value, 'offer_amount.currency_code': p.amount?.currency } as Record<string, string | undefined>)[field];
  }
}

/** Exactly the normalisation the contract records, applied to both sides; nothing else (no case folding, no inner spaces). */
function normalise(text: string, steps: ProofFields['normalise']): string {
  let t = text;
  if (steps.includes('crlf')) t = t.replace(/\r\n/g, '\n');
  if (steps.includes('trim')) t = t.trim();
  if (steps.includes('nfc')) t = t.normalize('NFC');
  return t;
}

/** The variant an intent sends, as the registry names it. */
export function variantOfContent(c: IntentContent): VariantId | null {
  const p = c.payload;
  switch (intentAction(c)) {
    case 'send_message':
      return variantOf('send_message', c.files.length ? 'file' : null);
    case 'accept_claim':
      return p?.kind === 'accept_claim' ? variantOf('accept_claim', p.acceptType) : null;
    case 'make_offer':
      return p?.kind === 'make_offer' ? variantOf('make_offer', p.offerType) : null;
    case 'escalate':
      return 'escalate';
    case 'appeal':
      return 'appeal';
    case 'provide_evidence':
      return variantOf('provide_evidence', c.evidenceType);
  }
}

/** PayPal still offers this action (its link, and for an accept or an offer, its type) in the read. */
function stillOffered(after: DisputeSnapshot, c: IntentContent): boolean {
  const action = intentAction(c);
  if (!after.allowedActions.includes(action)) return false;
  const p = c.payload;
  if (p?.kind === 'accept_claim') return (after.responseOptions?.acceptClaimTypes ?? []).includes(p.acceptType);
  if (p?.kind === 'make_offer') return (after.responseOptions?.offerTypes ?? []).includes(p.offerType);
  return true;
}

const PENDING = 'Outcome pending confirmation';

/**
 * Whether the read `after` proves this send recorded, proves it absent, or neither:
 * - `recorded`: a new entry of the contract's list (not in the base), by its actor, timed at or after send_started,
 *   with every match field equal to the approved content under the contract's normalisation;
 * - `absent`: no new entry by the actor, the action still offered, and the contract's absence delay passed;
 * - otherwise `pending`: a contract without proof fields, a bare state change, or another entry by the actor.
 */
export function proveSend(c: IntentContent, base: ReadBackBase, after: DisputeSnapshot, contract: VariantContract, nowMs: number): { state: ProofState; detail: string } {
  const pending = { state: 'pending' as const, detail: PENDING };
  const proof = contract.proof;
  if (!proof || !proof.list || !proof.actorField || !proof.actorValue || !proof.timeField || proof.matchFields.length === 0) return pending;
  if (variantOfContent(c) !== contract.id) return pending;

  // A multiset: an entry whose key matches a baseline entry's is new once those baseline entries are used up.
  const fresh = unseen(actorEntries(after, proof), (e) => e.key, base.entryKeys);
  const started = Date.parse(base.sentStartedAt);
  const approved = proof.matchFields.map((f) => [f, approvedValue(c, f)] as const);
  const ours = (e: Entry): boolean => {
    const t = Date.parse(value(e, proof.timeField!) ?? '');
    if (Number.isNaN(t) || Number.isNaN(started) || t < started) return false;
    return approved.every(([f, want]) => {
      const got = value(e, f);
      return want !== undefined && got !== null && normalise(got, proof.normalise) === normalise(want, proof.normalise);
    });
  };
  if (fresh.some(ours)) return { state: 'recorded', detail: 'Recorded by PayPal' };
  if (fresh.length) return { state: 'pending', detail: `${PENDING}: PayPal shows a different seller entry` };
  if (contract.absentAfterMs !== null && !Number.isNaN(started) && nowMs - started >= contract.absentAfterMs && stillOffered(after, c)) {
    return { state: 'absent', detail: 'PayPal shows no trace of this send and still offers the action' };
  }
  return pending;
}
