import { describe, expect, it } from 'vitest';
import w1 from '../../../../packages/paypal/contracts/send_message.json';
import w2 from '../../../../packages/paypal/contracts/send_message-request-id.json';
import w3 from '../../../../packages/paypal/contracts/send_message-file.json';
import w9 from '../../../../packages/paypal/contracts/accept_claim-partial_refund.json';
import w10 from '../../../../packages/paypal/contracts/accept_claim-refund.json';
import w5 from '../../../../packages/paypal/contracts/escalate.json';
import w6 from '../../../../packages/paypal/contracts/evidence-after-escalation.json';
import { CONTRACTS } from './actionContracts';
import { actionAvailability } from './actions';
import { SIM_TRANSITIONS, onSimulator, simulatorRefusal } from './simulatedActions';

interface RecordedDispute {
  status: string;
  dispute_life_cycle_stage: string;
  links?: Array<{ rel: string }>;
  allowed_response_options?: { accept_claim?: { accept_claim_types?: string[] }; make_offer?: { offer_types?: string[] } };
  messages?: Array<{ posted_by: string; content: string; time_posted: string; documents?: unknown[] }>;
  evidences?: Array<{ source?: string; date?: string; notes?: string; evidence_type?: string; dispute_life_cycle_stage?: string; documents?: unknown[]; action_info?: { action?: string; response_option?: string } }>;
  seller_response_due_date?: string;
  offer?: { history?: Array<{ actor?: string; event_type?: string; offer_type?: string; offer_time?: string; offer_amount?: { value: string; currency_code: string } }> };
  dispute_outcome?: { outcome_code?: string };
  refund_details?: { transactions?: unknown[] };
}
interface Recorded {
  variant: string;
  sentStartedAt: string;
  request: {
    body?: { message?: string; note?: string; accept_claim_type?: string; refund_amount?: { value: string; currency_code: string } };
    parts?: Array<{ name: string; body?: { message?: string; evidences?: Array<{ evidence_type: string; notes: string }> } }>;
  };
  before: RecordedDispute;
  after: Array<{ at: string; dispute: RecordedDispute }>;
}
const FILES: Record<string, Recorded> = {
  'packages/paypal/contracts/send_message.json': w1 as Recorded,
  'packages/paypal/contracts/send_message-request-id.json': w2 as unknown as Recorded,
  'packages/paypal/contracts/send_message-file.json': w3 as unknown as Recorded,
  'packages/paypal/contracts/accept_claim-refund.json': w10 as unknown as Recorded,
  'packages/paypal/contracts/accept_claim-partial_refund.json': w9 as unknown as Recorded,
  'packages/paypal/contracts/escalate.json': w5 as unknown as Recorded,
  'packages/paypal/contracts/evidence-after-escalation.json': w6 as unknown as Recorded,
};
// The request-id probe repeats W-1's request byte for byte.
const messageOf = (c: Recorded): string => c.request.body?.message ?? c.request.parts?.find((p) => p.name === 'input')?.body?.message ?? w1.request.body.message;
/** The action's new entry in a read after the POST, in the list the transition's entry kind names. */
function newEntries(kind: string, c: Recorded, after: RecordedDispute): Array<{ documents?: unknown[] }> {
  return entriesOf(kind, c, after) as Array<{ documents?: unknown[] }>;
}
function entriesOf(kind: string, c: Recorded, after: RecordedDispute): unknown[] {
  const before = c.before;
  if (kind === 'message') return newSellerEntry(before, after, messageOf(c));
  if (kind === 'escalate' || kind === 'evidence') {
    const seen = new Set((before.evidences ?? []).map((e) => e.date));
    const sent = c.request.parts?.find((p) => p.name === 'input')?.body?.evidences?.[0];
    return (after.evidences ?? []).filter((e) =>
      e.source === 'SUBMITTED_BY_SELLER' && !seen.has(e.date) && (kind === 'escalate'
        ? e.action_info?.action === 'ESCALATE' && e.notes === c.request.body?.note && e.dispute_life_cycle_stage === before.dispute_life_cycle_stage
        : e.action_info?.action === 'PROVIDE_EVIDENCE' && e.evidence_type === sent?.evidence_type && e.notes === sent?.notes && e.dispute_life_cycle_stage === before.dispute_life_cycle_stage),
    );
  }
  if (kind === 'accept_claim') {
    const seen = new Set((before.evidences ?? []).map((e) => e.date));
    return (after.evidences ?? []).filter(
      (e) => e.source === 'SUBMITTED_BY_SELLER' && !seen.has(e.date) && e.action_info?.action === 'ACCEPT_CLAIM' && e.action_info.response_option === c.request.body?.accept_claim_type && e.notes === c.request.body?.note,
    );
  }
  const seen = new Set((before.offer?.history ?? []).map((o) => o.offer_time));
  const want = c.request.body?.refund_amount;
  return (after.offer?.history ?? []).filter(
    (o) => o.actor === 'SELLER' && o.event_type === 'PROPOSED' && o.offer_type === 'REFUND' && !seen.has(o.offer_time) && o.offer_amount?.value === want?.value && o.offer_amount?.currency_code === want?.currency_code,
  );
}
/** PayPal's links as ResolveKit's action codes, in the mapper's order (packages/paypal SELLER_ACTIONS). */
const ORDER = ['provide_evidence', 'send_message', 'make_offer', 'accept_claim', 'escalate', 'appeal'];
const actionsOf = (d: RecordedDispute) => ORDER.filter((a) => (d.links ?? []).some((l) => l.rel === a));
const optionsOf = (d: RecordedDispute) => ({
  acceptClaimTypes: d.allowed_response_options?.accept_claim?.accept_claim_types ?? [],
  offerTypes: d.allowed_response_options?.make_offer?.offer_types ?? [],
});
const newSellerEntry = (before: RecordedDispute, after: RecordedDispute, text: string) =>
  (after.messages ?? []).filter((m) => m.posted_by === 'SELLER' && !(before.messages ?? []).some((b) => b.time_posted === m.time_posted) && m.content === text);

describe('simulator transitions come from the recorded contracts only', () => {
  it('every transition equals its contract file, read for read', () => {
    const all = Object.values(SIM_TRANSITIONS).flat();
    expect(all.length).toBe(7);
    for (const t of all) {
      const file = t.recorded.split(' ')[0]!;
      const c = FILES[file];
      expect(c, file).toBeDefined();
      expect(CONTRACTS[t.variant].recorded).toBe(file === 'packages/paypal/contracts/send_message-request-id.json' ? 'packages/paypal/contracts/send_message.json' : file);
      expect(t.from).toEqual({ stage: c!.before.dispute_life_cycle_stage, status: c!.before.status, allowedActions: actionsOf(c!.before) });
      expect(t.steps.map((s) => s.at)).toEqual(c!.after.map((a) => a.at));
      expect(c!.before.dispute_outcome?.outcome_code ?? null).toBeNull();
      expect(c!.before.refund_details?.transactions ?? []).toEqual([]);
      c!.after.forEach((a, i) => {
        const s = t.steps[i]!;
        expect({ status: s.status, stage: s.stage, allowedActions: s.allowedActions, responseOptions: s.responseOptions, outcome: s.outcome, refunded: s.refunded }, `${file} ${a.at}`).toEqual({
          status: a.dispute.status,
          stage: a.dispute.dispute_life_cycle_stage,
          allowedActions: actionsOf(a.dispute),
          responseOptions: optionsOf(a.dispute),
          outcome: a.dispute.dispute_outcome?.outcome_code ?? null,
          refunded: (a.dispute.refund_details?.transactions ?? []).length > 0,
        });
        // Requested evidence and the seller due date, where the transition plays them (W-5, W-6).
        if (s.requested !== undefined) expect(s.requested, `${file} ${a.at}`).toEqual((a.dispute.evidences ?? []).filter((e) => e.source === 'REQUESTED_FROM_SELLER').map((e) => e.evidence_type));
        if (s.dueAfterMs !== undefined) {
          const due = a.dispute.seller_response_due_date;
          expect(s.dueAfterMs, `${file} ${a.at}`).toBe(due ? Date.parse(due) - Date.parse(c!.sentStartedAt) : null);
        }
        const entry = newEntries(t.entry, c!, a.dispute);
        expect(s.entryVisible, `${file} ${a.at}`).toBe(entry.length === 1);
        if (entry.length) expect(entry[0]!.documents?.length ?? 0).toBe(t.documents);
      });
      expect(t.actionLagReads).toBe(t.steps.findIndex((s) => s.entryVisible));
    }
  });

  it('only variants with a recorded contract have transitions', () => {
    for (const v of Object.keys(SIM_TRANSITIONS) as Array<keyof typeof CONTRACTS>) expect(CONTRACTS[v].recorded).not.toBeNull();
    // After the first seller message PayPal no longer offers make_offer (W-1, +30 s on).
    expect(SIM_TRANSITIONS.send_message![0]!.steps.slice(1).every((s) => !s.allowedActions.includes('make_offer'))).toBe(true);
    // A partial accept never closes, never shows a refund; a full accept closes in the buyer's favour.
    expect(SIM_TRANSITIONS['accept_claim:PARTIAL_REFUND']![0]!.steps.every((s) => s.status !== 'RESOLVED' && !s.refunded && s.outcome === null)).toBe(true);
    expect(SIM_TRANSITIONS['accept_claim:REFUND']![0]!.steps.at(-1)).toMatchObject({ status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR', refunded: true });
    // An escalation never closes: UNDER_REVIEW in the inquiry, then the claim; each read gives requests and due date.
    const esc = SIM_TRANSITIONS.escalate![0]!;
    expect(esc.steps.every((s) => s.status !== 'RESOLVED' && s.outcome === null && s.requested !== undefined && s.dueAfterMs !== undefined)).toBe(true);
    expect(esc.steps.map((s) => s.stage)).toEqual(['INQUIRY', 'INQUIRY', 'INQUIRY', 'CHARGEBACK']);
    expect(SIM_TRANSITIONS['evidence:after_escalation']![0]!.steps.every((s) => s.stage === 'CHARGEBACK' && s.allowedActions.length === 0)).toBe(true);
  });
});

describe('what the simulator would refuse is not composable there', () => {
  const owner = { role: 'owner' as const, reviewer: false };
  const standard = { id: 'S', stage: 'INQUIRY', status: 'WAITING_FOR_SELLER_RESPONSE' as const, allowedActions: ['provide_evidence', 'send_message', 'make_offer', 'accept_claim'] as Array<'provide_evidence' | 'send_message' | 'make_offer' | 'accept_claim'>, evidences: [], readAt: '' };
  it('the standard case plays a message; another state or a file from it does not', () => {
    expect(simulatorRefusal('send_message', standard)).toBeNull();
    expect(simulatorRefusal('send_message:file', standard)).toMatch(/recorded/);
    const a = actionAvailability(standard, 'send_message', owner);
    expect(onSimulator(a, standard)).toBe(a);
    // Same stage and status, a link the recorded dispute never had: refused, with the reason.
    const odd = { ...standard, allowedActions: [...standard.allowedActions, 'appeal' as const] };
    const b = onSimulator(actionAvailability(odd, 'send_message', owner), odd);
    expect(b).toMatchObject({ sendable: false });
    expect(b.why).toMatch(/simulator/);
  });
});
