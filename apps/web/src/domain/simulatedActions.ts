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
}

export interface SimTransition {
  variant: VariantId;
  /** The contract file and write it comes from. */
  recorded: string;
  /** The state the write was sent from: the simulator plays it only from this state. */
  from: { stage: string; status: DisputeStatus };
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

const step = (at: string, status: DisputeStatus, allowedActions: ActionCode[], responseOptions: SimStep['responseOptions'], entryVisible = true): SimStep => ({
  at,
  afterMs: AFTER_MS[at]!,
  status,
  stage: 'INQUIRY',
  allowedActions,
  responseOptions,
  entryVisible,
});
const waitingBuyer = (at: string) => step(at, 'WAITING_FOR_BUYER_RESPONSE', WAITING_BUYER_ACTIONS, ACCEPT_REFUND);

export const SIM_TRANSITIONS: Readonly<Partial<Record<VariantId, readonly SimTransition[]>>> = Object.freeze({
  send_message: [
    // W-1: the first seller message. A transient UNDER_REVIEW with no links at +0 s, then PayPal waits for the buyer
    // and no longer offers make_offer; accept is REFUND only.
    {
      variant: 'send_message',
      recorded: 'packages/paypal/contracts/send_message.json (W-1)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE' },
      actionLagReads: 0,
      documents: 0,
      steps: [step('0s', 'UNDER_REVIEW', [], NONE), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
    // W-2: a message while PayPal waits for the buyer: a new seller entry, nothing else changes.
    {
      variant: 'send_message',
      recorded: 'packages/paypal/contracts/send_message-request-id.json (W-2)',
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE' },
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
      from: { stage: 'INQUIRY', status: 'WAITING_FOR_BUYER_RESPONSE' },
      actionLagReads: 0,
      documents: 1,
      steps: [waitingBuyer('0s'), waitingBuyer('30s'), waitingBuyer('2m'), waitingBuyer('10m')],
    },
  ],
});
