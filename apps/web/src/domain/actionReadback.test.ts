import { describe, expect, it } from 'vitest';
import { CONTRACTS, type ProofFields, type VariantContract } from './actionContracts';
import { ACTION_EVIDENCE_BLANK } from './actions';
import { proveSend, readBackBase } from './actionReadback';
import type { IntentContent } from './intent';
import type { DisputeMessage, DisputeSnapshot } from './types';

/**
 * A test-only contract (never a real registry entry flipped to available). The proof uses the field names of the
 * recorded reads: a seller message is a `messages[]` entry with `posted_by`, `time_posted` and `content`
 * (packages/paypal/contracts/reads/inquiry-after-evidence-TVH.json).
 */
const proof = (over: Partial<ProofFields> = {}): ProofFields => ({ list: 'messages', actorField: 'posted_by', actorValue: 'SELLER', timeField: 'time_posted', matchFields: ['content'], normalise: [], ...over });
const contract = (over: Partial<VariantContract> = {}): VariantContract => ({
  ...CONTRACTS.send_message,
  status: 'implemented',
  reason: null,
  proof: proof(),
  absentAfterMs: 60_000,
  recorded: 'test-only.json',
  evidence: 'test-only.md',
  ...over,
});

const SENT = '2026-10-19T10:00:00.000Z';
const SENT_MS = Date.parse(SENT);
const msg = (postedBy: string, time: string, content: string): DisputeMessage => ({ postedBy, time, content, files: [] });
const BUYER = msg('BUYER', '2026-10-18T08:04:20.960Z', 'Where is my parcel?');
const snap = (messages: DisputeMessage[], over: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
  id: 'case-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  allowedActions: ['send_message', 'provide_evidence', 'escalate'],
  evidences: [],
  readAt: '2026-10-19 10:00 UTC',
  messages,
  ...over,
});
const content = (text: string): IntentContent => ({
  caseId: 'case-1',
  disputeId: 'PP-R-TVH-10190665',
  ...ACTION_EVIDENCE_BLANK,
  files: [],
  action: 'send_message',
  payload: { kind: 'send_message', text },
  pin: { disputeId: 'PP-R-TVH-10190665', seller: 'S', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: null },
});

describe('read-back proof', () => {
  it('the base keeps the actor entries by key, the stage, the status and the send time; no message text', () => {
    const b = readBackBase(snap([BUYER, msg('SELLER', '2026-10-18T09:00:00.000Z', 'Hello')]), proof(), SENT);
    expect(b).toEqual({ entryKeys: ['SELLER|2026-10-18T09:00:00.000Z|5'], stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', sentStartedAt: SENT });
    expect(JSON.stringify(b)).not.toContain('Hello');
  });

  it('proof: an earlier identical message is not this one', () => {
    const before = snap([BUYER, msg('SELLER', '2026-10-18T09:00:00.000Z', 'Hello')]);
    const base = readBackBase(before, proof(), SENT);
    expect(proveSend(content('Hello'), base, before, contract(), SENT_MS + 1000)).toEqual({ state: 'pending', detail: 'Outcome pending confirmation' });
    const after = snap([...before.messages!, msg('SELLER', '2026-10-19T10:00:01.200Z', 'Hello')]);
    expect(proveSend(content('Hello'), base, after, contract(), SENT_MS + 2000)).toEqual({ state: 'recorded', detail: 'Recorded by PayPal' });
    // At exactly send_started it counts; before it, a new entry is not this send.
    expect(proveSend(content('Hello'), base, snap([...before.messages!, msg('SELLER', SENT, 'Hello')]), contract(), SENT_MS).state).toBe('recorded');
    expect(proveSend(content('Hello'), base, snap([...before.messages!, msg('SELLER', '2026-10-19T09:59:59.999Z', 'Hello')]), contract(), SENT_MS)).toEqual({
      state: 'pending',
      detail: 'Outcome pending confirmation: PayPal shows a different seller entry',
    });
    // A new buyer message with the text is another actor's.
    expect(proveSend(content('Hello'), base, snap([...before.messages!, msg('BUYER', '2026-10-19T10:00:05.000Z', 'Hello')]), contract(), SENT_MS + 5000).state).toBe('pending');
    // A new seller entry with other text: pending, with what PayPal shows.
    expect(proveSend(content('Hello'), base, snap([...before.messages!, msg('SELLER', '2026-10-19T10:00:05.000Z', 'Hello!')]), contract(), SENT_MS + 120_000)).toEqual({
      state: 'pending',
      detail: 'Outcome pending confirmation: PayPal shows a different seller entry',
    });
    // An unreadable time is not after send_started.
    expect(proveSend(content('Hello'), base, snap([...before.messages!, msg('SELLER', 'soon', 'Hello')]), contract(), SENT_MS).state).toBe('pending');
  });

  it('proof: normalisation from the contract', () => {
    const base = readBackBase(snap([BUYER]), proof(), SENT);
    const stored = (text: string) => snap([BUYER, msg('SELLER', '2026-10-19T10:00:02.000Z', text)]);
    const c = (normalise: ProofFields['normalise']) => contract({ proof: proof({ normalise }) });
    expect(proveSend(content('a\nb'), base, stored('a\r\nb '), c(['trim', 'crlf']), SENT_MS).state).toBe('recorded');
    // Stored as sent (no normalisation in the contract): nothing looser.
    expect(proveSend(content('a\nb'), base, stored('a\r\nb '), c([]), SENT_MS).state).toBe('pending');
    expect(proveSend(content('a\nb'), base, stored('a\r\nb '), c(['trim']), SENT_MS).state).toBe('pending');
    expect(proveSend(content('a\nb'), base, stored('a\r\nb '), c(['crlf']), SENT_MS).state).toBe('pending');
    // NFC not listed: a decomposed é does not match a composed one; listed, it does.
    expect(proveSend(content('café'), base, stored('café'), c(['trim', 'crlf']), SENT_MS).state).toBe('pending');
    expect(proveSend(content('café'), base, stored('café'), c(['nfc']), SENT_MS).state).toBe('recorded');
    // Case and inner spacing are never normalised.
    expect(proveSend(content('Hello there'), base, stored('hello  there'), c(['trim', 'crlf', 'nfc']), SENT_MS).state).toBe('pending');
  });

  it('proof: a bare state change is not proof', () => {
    const base = readBackBase(snap([BUYER]), proof(), SENT);
    const after = snap([BUYER], { status: 'RESOLVED', stage: 'INQUIRY', allowedActions: [], outcome: { code: 'RESOLVED_BUYER_FAVOUR', closedAt: '2026-10-19T10:00:03.000Z' } });
    expect(proveSend(content('Hello'), base, after, contract(), SENT_MS + 3_600_000)).toEqual({ state: 'pending', detail: 'Outcome pending confirmation' });
    expect(proveSend(content('Hello'), base, snap([BUYER], { stage: 'CHARGEBACK' }), contract(), SENT_MS + 1000).state).toBe('pending');
  });

  it('proof: absent only after absentAfterMs and while still offered', () => {
    const before = snap([BUYER]);
    const base = readBackBase(before, proof(), SENT);
    expect(proveSend(content('Hello'), base, before, contract(), SENT_MS + 59_999).state).toBe('pending');
    expect(proveSend(content('Hello'), base, before, contract(), SENT_MS + 60_000)).toEqual({ state: 'absent', detail: 'PayPal shows no trace of this send and still offers the action' });
    expect(proveSend(content('Hello'), base, snap([BUYER], { allowedActions: ['provide_evidence'] }), contract(), SENT_MS + 600_000).state).toBe('pending');
    // A contract without an absence delay never proves absence.
    expect(proveSend(content('Hello'), base, before, contract({ absentAfterMs: null }), SENT_MS + 86_400_000).state).toBe('pending');
    // A new seller entry that is not this send: never absent.
    expect(proveSend(content('Hello'), base, snap([BUYER, msg('SELLER', '2026-10-19T10:00:05.000Z', 'Other')]), contract(), SENT_MS + 600_000).state).toBe('pending');
  });

  it('proof: the baseline is a multiset, so a new entry with a baseline key is still new (never a false absent)', () => {
    const untimed: DisputeMessage = { postedBy: 'SELLER', time: null, content: 'Hello', files: [] };
    const before = snap([BUYER, untimed]);
    const base = readBackBase(before, proof(), SENT);
    expect(base.entryKeys).toEqual(['SELLER||5']);
    expect(proveSend(content('Hello'), base, before, contract(), SENT_MS + 600_000).state).toBe('absent');
    const twice = snap([BUYER, untimed, untimed]);
    expect(proveSend(content('Hello'), base, twice, contract(), SENT_MS + 600_000)).toEqual({ state: 'pending', detail: 'Outcome pending confirmation: PayPal shows a different seller entry' });
  });

  it('proof: a contract without proof fields never records', () => {
    const before = snap([BUYER]);
    const base = readBackBase(before, proof(), SENT);
    const after = snap([BUYER, msg('SELLER', '2026-10-19T10:00:05.000Z', 'Hello')]);
    for (const c of [contract({ proof: null }), contract({ proof: proof({ list: null }) }), contract({ proof: proof({ actorField: null }) }), contract({ proof: proof({ timeField: null }) }), contract({ proof: proof({ matchFields: [] }) })]) {
      expect(proveSend(content('Hello'), base, after, c, SENT_MS + 1000).state).toBe('pending');
      expect(proveSend(content('Hello'), base, before, c, SENT_MS + 86_400_000).state).toBe('pending');
    }
    // A match field the approved content has no value for never matches (nothing looser).
    expect(proveSend(content('Hello'), base, after, contract({ proof: proof({ matchFields: ['content', 'subject'] }) }), SENT_MS + 1000).state).toBe('pending');
    // A contract of another variant than the intent's is not this send's proof.
    expect(proveSend(content('Hello'), base, after, contract({ id: 'escalate' }), SENT_MS + 1000).state).toBe('pending');
  });

  it('proof on evidences: the accept entry by the contract fields', () => {
    const accept: ProofFields = { list: 'evidences', actorField: 'source', actorValue: 'SUBMITTED_BY_SELLER', timeField: 'date', matchFields: ['action_info.action', 'notes'], normalise: [] };
    const c = contract({ ...CONTRACTS['accept_claim:REFUND'], status: 'implemented', reason: null, proof: accept, absentAfterMs: null });
    const ac: IntentContent = { ...content(''), action: 'accept_claim', payload: { kind: 'accept_claim', acceptType: 'REFUND', note: 'Refunding.', amount: null } };
    const buyerEv = { evidenceType: 'CREATE', source: 'SUBMITTED_BY_BUYER', date: '2026-10-08T18:18:44.365Z', carrier: '', tracking: '', notes: 'x', files: [], storedAt: '' };
    const before = snap([], { evidences: [buyerEv] });
    const base = readBackBase(before, accept, SENT);
    expect(base.entryKeys).toEqual([]);
    const sellerEv = { ...buyerEv, evidenceType: 'OTHER', source: 'SUBMITTED_BY_SELLER', action: 'ACCEPT_CLAIM', date: '2026-10-19T10:00:02.892Z', notes: 'Refunding.' };
    expect(proveSend(ac, base, snap([], { evidences: [buyerEv, sellerEv], status: 'RESOLVED' }), c, SENT_MS).state).toBe('recorded');
    expect(proveSend(ac, base, snap([], { evidences: [buyerEv, { ...sellerEv, action: 'PROVIDE_EVIDENCE' }] }), c, SENT_MS).state).toBe('pending');
    // A field the snapshot does not carry (here the accept type, when PayPal gives none) cannot be matched: pending.
    const withType = contract({ ...c, proof: { ...accept, matchFields: [...accept.matchFields, 'action_info.response_option'] } });
    expect(proveSend(ac, base, snap([], { evidences: [buyerEv, sellerEv] }), withType, SENT_MS).state).toBe('pending');
  });

  // Task 9: the production proofs of accept_claim (packages/paypal/contracts/accept_claim-*.json).
  const buyerCreate = { evidenceType: 'CREATE', source: 'SUBMITTED_BY_BUYER', date: '2026-10-19T19:39:45.831Z', carrier: '', tracking: '', notes: '<buyer message>', files: [], storedAt: '', stage: 'INQUIRY' };
  const acceptOf = (acceptType: string, note: string, amount: { value: string; currency: string } | null = null): IntentContent => ({
    ...content(''),
    action: 'accept_claim',
    payload: { kind: 'accept_claim', acceptType, note, amount },
    pin: { disputeId: 'PP-R-PAU-10193600', seller: 'S', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', amount: { value: '7.00', currency: 'USD' } },
  });

  it('accept REFUND: the ACCEPT_CLAIM entry with response_option REFUND and the note; RESOLVED alone is pending', () => {
    const c = CONTRACTS['accept_claim:REFUND'];
    const ac = acceptOf('REFUND', 'Full refund accepted.');
    const before = snap([], { evidences: [buyerCreate] });
    const base = readBackBase(before, c.proof!, SENT);
    const entry = { ...buyerCreate, evidenceType: 'OTHER', source: 'SUBMITTED_BY_SELLER', action: 'ACCEPT_CLAIM', responseOption: 'REFUND', date: '2026-10-19T10:00:05.035Z', notes: 'Full refund accepted.' };
    expect(proveSend(ac, base, snap([], { evidences: [buyerCreate, entry], status: 'UNDER_REVIEW', allowedActions: [] }), c, SENT_MS + 5_000).state).toBe('recorded');
    // RESOLVED in the buyer's favour, with a refund, but no attributable entry: never proof.
    const resolved = snap([], { evidences: [buyerCreate], status: 'RESOLVED', allowedActions: [], outcome: { code: 'RESOLVED_BUYER_FAVOUR', closedAt: null } });
    expect(proveSend(ac, base, resolved, c, SENT_MS + 120_000)).toEqual({ state: 'pending', detail: 'Outcome pending confirmation' });
    // Another accept type, another note, an entry before send_started: not this send.
    for (const other of [{ ...entry, responseOption: 'PARTIAL_REFUND' }, { ...entry, notes: 'Other note.' }, { ...entry, date: '2026-10-19T09:59:59.000Z' }, { ...entry, responseOption: null }])
      expect(proveSend(ac, base, snap([], { evidences: [buyerCreate, other] }), c, SENT_MS + 5_000).state).toBe('pending');
    // Without a note: PayPal's notes absent ('' once mapped) matches the empty note, nothing else.
    expect(proveSend(acceptOf('REFUND', ''), base, snap([], { evidences: [buyerCreate, { ...entry, notes: '' }] }), c, SENT_MS + 5_000).state).toBe('recorded');
  });

  it('accept PARTIAL_REFUND: the SELLER PROPOSED offer entry (type REFUND, the partial amount); no ACCEPT_CLAIM entry is expected', () => {
    const c = CONTRACTS['accept_claim:PARTIAL_REFUND'];
    const ac = acceptOf('PARTIAL_REFUND', 'Partial refund offered.', { value: '2.00', currency: 'USD' });
    const before = snap([], { evidences: [buyerCreate], offerHistory: [] });
    const base = readBackBase(before, c.proof!, SENT);
    const offer = { time: '2026-10-19T10:00:04.000Z', actor: 'SELLER', event: 'PROPOSED', type: 'REFUND', amount: { value: '2.00', currency: 'USD' } };
    expect(proveSend(ac, base, snap([], { evidences: [buyerCreate], offerHistory: [offer] }), c, SENT_MS + 5_000).state).toBe('recorded');
    for (const other of [{ ...offer, amount: { value: '3.00', currency: 'USD' } }, { ...offer, event: 'ACCEPTED' }, { ...offer, actor: 'BUYER' }, { ...offer, type: 'REPLACEMENT' }])
      expect(proveSend(ac, base, snap([], { offerHistory: [other] }), c, SENT_MS + 5_000).state).toBe('pending');
    // A full accept is not proven by an offer entry, nor a partial one by an ACCEPT_CLAIM entry.
    expect(proveSend(acceptOf('REFUND', 'Partial refund offered.'), base, snap([], { offerHistory: [offer] }), CONTRACTS['accept_claim:REFUND'], SENT_MS + 5_000).state).toBe('pending');
    const acceptEntry = { ...buyerCreate, evidenceType: 'OTHER', source: 'SUBMITTED_BY_SELLER', action: 'ACCEPT_CLAIM', responseOption: 'PARTIAL_REFUND', date: '2026-10-19T10:00:05.035Z', notes: 'Partial refund offered.' };
    expect(proveSend(ac, base, snap([], { evidences: [buyerCreate, acceptEntry] }), c, SENT_MS + 5_000).state).toBe('pending');
  });
});
