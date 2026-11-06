/**
 * Discovery: whether a PayPal dispute becomes a discovered case (docs/09-DISENO-DESCUBRIMIENTO.md, decisions 7, 8, 13
 * and 17). The caller hands over a full dispute (read with `disputes.get`; list items lack the transaction details).
 * Strict, fail closed: the evaluation seller's dispute, not bound yet, "not received", WAITING_FOR_SELLER_RESPONSE with
 * a future response date, exactly one disputed capture whose `invoice_id` names a ResolveKit order, and the payment the
 * order stands for (standard / settlement: the template's amount, on the capture and on the dispute; agent: the
 * MeterMCP receipt's capture of this very capture, equal to the disputed amount). Anything else is skipped with a
 * reason; a failed read is a skip too, never a throw. Admissions run one at a time, so the same dispute arriving twice
 * at once (webhook and scan) makes one case.
 */
import { CASE_FILES, TEMPLATE_CASE_IDS, templateForOrderRef } from '@resolvekit/cases';
import type { Dispute, PayPalClient } from '@resolvekit/paypal';
import type { DiscoveredCase, CaseStore } from './caseStore.ts';
import { receiptPaymentOf, type MeterMcpSource } from './metermcp.ts';

export type Admission = { created: DiscoveredCase } | { skipped: string };

type Money = { value?: string; currency_code?: string } | undefined;

function cents(value: string | undefined): number | null {
  if (value == null || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

/** Same currency and amount; a missing or malformed amount never matches. */
function sameMoney(m: Money, value: string, currency: string): boolean {
  const c = cents(m?.value);
  return !!m && m.currency_code === currency && c != null && c === cents(value);
}

export function createDiscovery(o: {
  paypal: Pick<PayPalClient, 'payments'>;
  meterMcp?: Pick<MeterMcpSource, 'findByCapture' | 'receipt'> | null;
  store: CaseStore;
  /** The evaluation seller's merchant id, or null when none is known yet. */
  anchor: () => string | null;
  /** Whether a fixed binding (or one of its reserves) already holds this dispute; the store is checked as well. */
  isBound: (disputeId: string) => boolean;
  now?: () => Date;
  log?: (s: string) => void;
}): { admit(d: Dispute, source: 'webhook' | 'scan'): Promise<Admission> } {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});

  async function decide(d: Dispute, source: 'webhook' | 'scan'): Promise<Admission> {
    const id = d.dispute_id ?? '';
    const anchor = o.anchor();
    if (!anchor) return { skipped: 'no evaluation seller configured' };
    const txs = d.disputed_transactions ?? [];
    const merchantId = txs[0]?.seller?.merchant_id;
    if (!merchantId || merchantId !== anchor) return { skipped: "another seller's dispute" };
    if (!id || o.isBound(id) || o.store.byDispute(id)) return { skipped: 'already bound' };
    if (d.reason !== 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') return { skipped: 'not a not-received dispute' };
    if (d.status !== 'WAITING_FOR_SELLER_RESPONSE') return { skipped: `not waiting for the seller (${d.status ?? 'no status'})` };
    const due = Date.parse(d.seller_response_due_date ?? '');
    if (!Number.isFinite(due) || due <= now().getTime()) return { skipped: 'past its response date' };
    const captureId = txs[0]?.seller_transaction_id;
    if (txs.length !== 1 || !captureId) return { skipped: 'no disputed capture' };

    let capture;
    try {
      capture = await o.paypal.payments.getCapture(captureId);
    } catch (e) {
      log(`discovery · ${id} · capture ${captureId} could not be read · ${e instanceof Error ? e.message : String(e)}`);
      return { skipped: 'capture could not be read' };
    }
    const order = templateForOrderRef(capture.invoice_id);
    if (!order) return { skipped: 'not from a ResolveKit order' };

    // What the order was paid: the template's amount, or for the agent what its MeterMCP receipt captured.
    let expected: { value: string; currency: string };
    if (order.template === 'agent') {
      let paid;
      try {
        paid = o.meterMcp ? await receiptPaymentOf(o.meterMcp, d) : null;
      } catch (e) {
        log(`discovery · ${id} · MeterMCP could not be read · ${e instanceof Error ? e.message : String(e)}`);
        paid = null;
      }
      if (!paid) return { skipped: 'no MeterMCP receipt for this capture' };
      expected = paid;
    } else {
      const summary = CASE_FILES[TEMPLATE_CASE_IDS[order.template]]!.summary;
      expected = { value: summary.amount, currency: summary.currency };
      if (!sameMoney(capture.amount, expected.value, expected.currency)) return { skipped: 'amount does not match the order' };
    }
    if (!sameMoney(d.dispute_amount, expected.value, expected.currency)) return { skipped: 'amount does not match the order' };
    const gross = txs[0]?.gross_amount;
    if (gross && !sameMoney(gross, expected.value, expected.currency)) return { skipped: 'amount does not match the order' };

    const created: DiscoveredCase = {
      caseId: id,
      merchantId,
      disputeId: id,
      captureId,
      template: order.template,
      orderRef: order.orderRef,
      source,
      createdAt: now().toISOString(),
    };
    if (!o.store.add(created)) {
      if (o.store.byDispute(id)) return { skipped: 'already bound' };
      log(`discovery · ${id} · the case could not be stored · ${o.store.storageProblem() ?? 'unknown problem'}`);
      return { skipped: 'case could not be stored' };
    }
    return { created };
  }

  let chain: Promise<unknown> = Promise.resolve();
  return {
    admit(d, source) {
      const run = chain.then(async (): Promise<Admission> => {
        let a: Admission;
        try {
          a = await decide(d, source);
        } catch (e) {
          // Defensive: decide() catches its reads; an unexpected throw is still a skip, never a rejection.
          log(`discovery · ${d.dispute_id ?? '?'} · unexpected error · ${e instanceof Error ? e.message : String(e)}`);
          return { skipped: 'capture could not be read' };
        }
        if ('created' in a) log(`discovery · ${a.created.disputeId} · case created (${a.created.template}, ${a.created.orderRef}) · ${source}`);
        else log(`discovery · ${d.dispute_id ?? '?'} · skipped: ${a.skipped} · ${source}`);
        return a;
      });
      chain = run;
      return run;
    },
  };
}
