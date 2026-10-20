/**
 * What the in-browser simulator does when a dispute action is sent ([A7]): only the transitions PayPal's sandbox showed
 * in a recorded contract (packages/paypal/contracts/), read for read. Nothing here is invented to complete the demo; a
 * variant, or a starting state, without a recorded write is refused by the simulator («not available in the simulator»).
 *
 * Each transition is the recorded `before` state (stage and status) and, for each read taken after PayPal answered
 * the POST (`after[].at`), the status, stage, links (as ResolveKit's action codes) and allowed response options, and
 * whether the new entry was visible in that read. simulatedActions.test.ts checks every value against the contract
 * files, so this table cannot drift from what was recorded.
 */
import type { VariantId } from './actionContracts';
import type { ActionAvailability } from './actions';
import type { ActionCode, DisputeStatus } from './types';

/** One recorded read after the POST answered. */
export interface SimStep {
  /** The read's label in the contract (`0s`, `30s`, `2m`, `10m`). */
  at: string;
  /** When the read was taken, in ms after PayPal answered the POST. */
  afterMs: number;
  status: DisputeStatus;
  stage: string;
  /** The links PayPal gave in that read, as action codes (the self link is not an action). */
  allowedActions: ActionCode[];
  responseOptions: { acceptClaimTypes: string[]; offerTypes: string[] };
  /** The action's new entry (e.g. the seller's message) was in that read. */
  entryVisible: boolean;
  /** PayPal's `dispute_outcome.outcome_code` in that read (W-10 from +2 min: RESOLVED_BUYER_FAVOUR); null: none. */
  outcome: string | null;
  /** `refund_details.transactions[]` listed a refund in that read (W-10: at once). */
  refunded: boolean;
  /**
   * The evidence types PayPal requested from the seller in that read (REQUESTED_FROM_SELLER entries; W-5 +10 min: the
   * claim's PROOF_OF_FULFILLMENT, PROOF_OF_REFUND, OTHER). Absent: the transition does not change them.
   */
  requested?: string[];
  /**
   * `seller_response_due_date` in that read, as ms after the send started (W-5 +10 min: the claim's due date); null: no
   * due date in that read. Absent: the transition does not change it.
   */
  dueAfterMs?: number | null;
}

/**
 * What the action's new entry is, as the recorded reads show it: a seller message (W-1–W-3), an ACCEPT_CLAIM evidence
 * entry with the accept type and the note (W-10), a SELLER PROPOSED offer with the amount and the note echoed as a seller
 * message at the offer's time (W-9, W-4), the seller's
 * ESCALATE evidence entry with the note in the inquiry stage (W-5), or the seller's evidence in the claim stage (W-6).
 */
export type SimEntry = 'message' | 'accept_claim' | 'offer' | 'escalate' | 'evidence';

export interface SimTransition {
  variant: VariantId;
  /** The contract file and write it comes from. */
  recorded: string;
  /**
   * The state the write was sent from: its stage, status and links (as action codes). The simulator plays it only from
   * this stage and status, on a dispute that offers no link the recorded one did not.
   */
  from: { stage: string; status: DisputeStatus; allowedActions: ActionCode[] };
  entry: SimEntry;
  /** How many reads after the POST did not show the entry yet (0: the first read showed it). */
  actionLagReads: number;
  /** Documents on the new entry (a message with a file: 1, with no name PayPal gives back). */
  documents: number;
  steps: SimStep[];
}

const AFTER_MS: Readonly<Record<string, number>> = { '0s': 0, '30s': 30_000, '2m': 120_000, '10m': 600_000 };
const NONE = { acceptClaimTypes: [], offerTypes: [] };
const WAITING_BUYER_ACTIONS: ActionCode[] = ['provide_evidence', 'send_message', 'accept_claim', 'escalate'];
const ACCEPT_REFUND = { acceptClaimTypes: ['REFUND'], offerTypes: [] };

const step = (
  at: string,
  status: DisputeStatus,
  allowedActions: ActionCode[],
  responseOptions: SimStep['responseOptions'],
  o: { entryVisible?: boolean; outcome?: string | null; refunded?: boolean; stage?: string; requested?: string[]; dueAfterMs?: number | null } = {},
): SimStep => ({
  at,
  afterMs: AFTER_MS[at]!,
  status,
  stage: o.stage ?? 'INQUIRY',
  allowedActions,
  responseOptions,
  entryVisible: o.entryVisible ?? true,
  outcome: o.outcome ?? null,
  refunded: o.refunded ?? false,
  ...(o.requested ? { requested: o.requested } : {}),
  ...(o.dueAfterMs !== undefined ? { dueAfterMs: o.dueAfterMs } : {}),
});
const waitingBuyer = (at: string) => step(at, 'WAITING_FOR_BUYER_RESPONSE', WAITING_BUYER_ACTIONS, ACCEPT_REFUND);
const WAITING_SELLER_ACTIONS: ActionCode[] = ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate'];
const BUYER_FAVOUR = 'RESOLVED_BUYER_FAVOUR';
/** The claim after an escalation, waiting for the seller (W-5 +10 min, W-6 before). */
const CLAIM_ACTIONS: ActionCode[] = ['provide_evidence', 'accept_claim'];
const CLAIM_OPTIONS = { acceptClaimTypes: ['REFUND', 'PARTIAL_REFUND'], offerTypes: [] };
/** W-5: the claim's due date, from when the escalation was sent (2026-10-30T22:59:59Z − 2026-10-20T06:17:37.925Z). */
const CLAIM_DUE_AFTER_MS = Date.parse('2026-10-30T22:59:59.000Z') - Date.parse('2026-10-20T06:17:37.925Z');
const reviewing = (at: string, stage: string, allowedActions: ActionCode[] = [], requested: string[] = []) =>
  step(at, 'UNDER_REVIEW', allowedActions, NONE, { stage, requested, dueAfterMs: null });

export const SIM_TRANSITIONS: Readonly<Partial<Record<VariantId, readonly SimTransition[]>>> = Object.freeze({
  send_message: [
    // W-1: the first seller message. A transient UNDER_REVIEW with no links at +0 s, then PayPal waits for the buyer
    // and no longer offers make_offer; accept is REFUND only.
    {
      variant: 'send_message',
      recorded: 'packages/paypal/contracts/send_message.json (W-1)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: WAITING_SELLER_ACTIONS },
      entry: 'message',
      actionLagReads: 0,
      documents: 0,
      steps: [step('0s', 'UNDER_REVIEW', [], NONE), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
    // W-2: a message while PayPal waits for the buyer: a new seller entry, nothing else changes.
    {
      variant: 'send_message',
      recorded: 'packages/paypal/contracts/send_message-request-id.json (W-2)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: WAITING_BUYER_ACTIONS },
      entry: 'message',
      actionLagReads: 0,
      documents: 0,
      steps: [waitingBuyer('0s'), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
  ],
  'send_message:file': [
    // W-3: a message with a file while PayPal waits for the buyer; the entry carries one document.
    {
      variant: 'send_message:file',
      recorded: 'packages/paypal/contracts/send_message-file.json (W-3)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE', allowedActions: WAITING_BUYER_ACTIONS },
      entry: 'message',
      actionLagReads: 0,
      documents: 1,
      steps: [waitingBuyer('0s'), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
  ],
  'accept_claim:REFUND': [
    // W-10: the ACCEPT_CLAIM entry and the refund at once, UNDER_REVIEW (the provide_evidence link flickered at +30 s),
    // then RESOLVED in the buyer's favour from +2 min with no links. Money moved and the dispute closed.
    {
      variant: 'accept_claim:REFUND',
      recorded: 'packages/paypal/contracts/accept_claim-refund.json (W-10)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: WAITING_SELLER_ACTIONS },
      entry: 'accept_claim',
      actionLagReads: 0,
      documents: 0,
      steps: [
        step('0s', 'UNDER_REVIEW', [], NONE, { refunded: true }),
        step('30s', 'UNDER_REVIEW', ['provide_evidence'], NONE, { refunded: true }),
        step('2m', 'RESOLVED', [], NONE, { refunded: true, outcome: BUYER_FAVOUR }),
        step('10m', 'RESOLVED', [], NONE, { refunded: true, outcome: BUYER_FAVOUR }),
      ],
    },
  ],
  'accept_claim:PARTIAL_REFUND': [
    // W-9: PayPal records a partial accept as the seller's offer (SELLER PROPOSED, type REFUND, the amount); nothing
    // closes and no money moves. UNDER_REVIEW with no links at +0 s, then it waits for the buyer: accept REFUND only,
    // make_offer no longer offered.
    {
      variant: 'accept_claim:PARTIAL_REFUND',
      recorded: 'packages/paypal/contracts/accept_claim-partial_refund.json (W-9)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: WAITING_SELLER_ACTIONS },
      entry: 'offer',
      actionLagReads: 0,
      documents: 0,
      steps: [step('0s', 'UNDER_REVIEW', [], NONE), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
  ],
  'make_offer:REFUND': [
    // W-4: the seller's offer (SELLER PROPOSED, type REFUND, the amount offered) at once; nothing closes and no money
    // moves. UNDER_REVIEW with no links at +0 s, then it waits for the buyer: accept REFUND only, make_offer no longer
    // offered. The simulator plays it only from this state, with no seller message and no pending offer before.
    {
      variant: 'make_offer:REFUND',
      recorded: 'packages/paypal/contracts/make_offer-refund.json (W-4)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: WAITING_SELLER_ACTIONS },
      entry: 'offer',
      actionLagReads: 0,
      documents: 0,
      steps: [step('0s', 'UNDER_REVIEW', [], NONE), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
  ],
  escalate: [
    // W-5: the seller's ESCALATE entry with the note at once; UNDER_REVIEW in the inquiry with flickering links (+30 s:
    // provide_evidence and a PROOF_OF_FULFILLMENT request for a moment), then the claim (CHARGEBACK) waiting for the
    // seller by +10 min: evidence and accept offered, three evidence types requested, a new seller due date.
    {
      variant: 'escalate',
      recorded: 'packages/paypal/contracts/escalate.json (W-5)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: WAITING_SELLER_ACTIONS },
      entry: 'escalate',
      actionLagReads: 0,
      documents: 0,
      steps: [
        reviewing('0s', 'INQUIRY'),
        reviewing('30s', 'INQUIRY', ['provide_evidence'], ['PROOF_OF_FULFILLMENT']),
        reviewing('2m', 'INQUIRY'),
        step('10m', 'WAITING_FOR_SELLER_RESPONSE', CLAIM_ACTIONS, CLAIM_OPTIONS, { stage: 'CHARGEBACK', requested: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'OTHER'], dueAfterMs: CLAIM_DUE_AFTER_MS }),
      ],
    },
  ],
  'evidence:after_escalation': [
    // W-6: evidence in the claim after the escalation: the seller's entry (stage CHARGEBACK, one document) at once, then
    // UNDER_REVIEW in the claim; PayPal's only link is provide_supporting_info, which is not in this delivery.
    {
      variant: 'evidence:after_escalation',
      recorded: 'packages/paypal/contracts/evidence-after-escalation.json (W-6)',
      from: { stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE', allowedActions: CLAIM_ACTIONS },
      entry: 'evidence',
      actionLagReads: 0,
      documents: 1,
      steps: [reviewing('0s', 'CHARGEBACK'), reviewing('30s', 'CHARGEBACK'), reviewing('2m', 'CHARGEBACK'), reviewing('10m', 'CHARGEBACK')],
    },
  ],
});

/**
 * The recorded transition the simulator plays from this dispute: the same stage and status as a recorded write, and
 * no link the recorded dispute did not offer (a subset, not equality: the demo cases' links are fixed by their
 * analysis keys, e.g. the standard case offers no escalate). Null: the simulator refuses it.
 */
export function transitionFrom(list: readonly SimTransition[] | undefined, d: Pick<DisputeSnapshotLike, 'stage' | 'status' | 'allowedActions'>): SimTransition | null {
  return (list ?? []).find((x) => x.from.stage === (d.stage ?? null) && x.from.status === d.status && d.allowedActions.every((a) => x.from.allowedActions.includes(a))) ?? null;
}

interface DisputeSnapshotLike {
  stage?: string | null;
  status: string;
  allowedActions: readonly ActionCode[];
}

/** Why the simulator would refuse this variant on this dispute now, or null when it plays a recorded transition. */
export function simulatorRefusal(variant: VariantId, d: DisputeSnapshotLike): string | null {
  return transitionFrom(SIM_TRANSITIONS[variant], d) ? null : 'the simulator plays this only from a state PayPal’s sandbox recorded it from';
}

/**
 * The message-with-a-file variant on the simulator: «Not available», with the simulator's reason, from any state W-3
 * was not recorded from (it was sent from WAITING_FOR_BUYER_RESPONSE). The text-only message keeps its own transitions;
 * the action stays sendable as {@link onSimulator} decided.
 */
export function onSimulatorFile(a: ActionAvailability, d: DisputeSnapshotLike): ActionAvailability {
  const variants = a.variants.map((v) => {
    if (v.variant !== 'send_message:file' || !v.available) return v;
    const why = simulatorRefusal(v.variant, d);
    return why ? { ...v, available: false, why } : v;
  });
  return variants.some((v, i) => v !== a.variants[i]) ? { ...a, variants } : a;
}

/**
 * The availability on the simulator: also refused where the simulator would refuse it (no recorded transition from
 * this state), so the person is never let compose what the simulator will not play.
 */
export function onSimulator(a: ActionAvailability, d: DisputeSnapshotLike): ActionAvailability {
  if (!a.sendable) return a;
  const playable = a.variants.filter((v) => v.available && v.variant && !simulatorRefusal(v.variant, d));
  if (playable.length) return a;
  const first = a.variants.find((v) => v.available && v.variant);
  return { ...a, sendable: false, why: first?.variant ? simulatorRefusal(first.variant, d) : 'the simulator does not play this action' };
}
