import { describe, expect, it } from 'vitest';
import w1 from '../../../../packages/paypal/contracts/send_message.json';
import w2 from '../../../../packages/paypal/contracts/send_message-request-id.json';
import w3 from '../../../../packages/paypal/contracts/send_message-file.json';
import { CONTRACTS } from './actionContracts';
import { SIM_TRANSITIONS } from './simulatedActions';

interface RecordedDispute {
  status: string;
  dispute_life_cycle_stage: string;
  links?: Array<{ rel: string }>;
  allowed_response_options?: { accept_claim?: { accept_claim_types?: string[] }; make_offer?: { offer_types?: string[] } };
  messages?: Array<{ posted_by: string; content: string; time_posted: string; documents?: unknown[] }>;
}
interface Recorded {
  variant: string;
  sentStartedAt: string;
  request: { body?: { message: string }; parts?: Array<{ name: string; body?: { message: string } }> };
  before: RecordedDispute;
  after: Array<{ at: string; dispute: RecordedDispute }>;
}
const FILES: Record<string, Recorded> = {
  'packages/paypal/contracts/send_message.json': w1 as Recorded,
  'packages/paypal/contracts/send_message-request-id.json': w2 as unknown as Recorded,
  'packages/paypal/contracts/send_message-file.json': w3 as unknown as Recorded,
};
// The request-id probe repeats W-1's request byte for byte.
const messageOf = (c: Recorded): string => c.request.body?.message ?? c.request.parts?.find((p) => p.name === 'input')?.body?.message ?? w1.request.body.message;
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
    expect(all.length).toBe(3);
    for (const t of all) {
      const file = t.recorded.split(' ')[0]!;
      const c = FILES[file];
      expect(c, file).toBeDefined();
      expect(CONTRACTS[t.variant].recorded).toBe(file === 'packages/paypal/contracts/send_message-request-id.json' ? 'packages/paypal/contracts/send_message.json' : file);
      expect(t.from).toEqual({ stage: c!.before.dispute_life_cycle_stage, status: c!.before.status });
      expect(t.steps.map((s) => s.at)).toEqual(c!.after.map((a) => a.at));
      const text = messageOf(c!);
      c!.after.forEach((a, i) => {
        const s = t.steps[i]!;
        expect({ status: s.status, stage: s.stage, allowedActions: s.allowedActions, responseOptions: s.responseOptions }, `${file} ${a.at}`).toEqual({
          status: a.dispute.status,
          stage: a.dispute.dispute_life_cycle_stage,
          allowedActions: actionsOf(a.dispute),
          responseOptions: optionsOf(a.dispute),
        });
        const entry = newSellerEntry(c!.before, a.dispute, text);
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
  });
});
