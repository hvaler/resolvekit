/**
 * The session receipt: the mandate (PayPal order and authorization, cap), every call with its request hash, the
 * totals and the settlement (PayPal capture). Served as JSON and as a PDF; ResolveKit reads the JSON and attaches
 * the PDF to the dispute as proof of fulfillment.
 */
import type { PayPalEnv } from '@resolvekit/paypal';
import { writePdf } from '@resolvekit/pdf';
import { canonicalJson, sha256 } from './hash.ts';
import type { CallRow, CallStatus, SessionRow, SessionStatus } from './ledger.ts';
import { fromCents } from './money.ts';
import { SESSION_ITEM_NAME } from './names.ts';

export interface ReceiptCall {
  n: number;
  time: string;
  tool: string;
  price: string;
  status: CallStatus;
  request_hash: string;
  response_hash: string | null;
  error: string | null;
}

export interface Receipt {
  kind: 'metermcp.session_receipt';
  version: 1;
  paypal_env: PayPalEnv;
  session: { id: string; status: SessionStatus; currency: string; created_at: string; closed_at: string | null };
  mandate: {
    item: string;
    category: 'DIGITAL_GOODS';
    cap: string;
    order_id: string | null;
    authorization_id: string | null;
    authorization_status: string | null;
    authorization_expires_at: string | null;
    /** When MeterMCP saw the buyer's approval and authorized the order. */
    approved_at: string | null;
    /** PayPal's create_time of the authorization. */
    authorized_at: string | null;
  };
  calls: ReceiptCall[];
  totals: { calls: number; ok: number; failed: number; pending: number; charged: string; cap: string };
  settlement: {
    status: 'open' | 'captured' | 'voided' | 'failed' | 'not_approved';
    capture_id: string | null;
    capture_status: string | null;
    invoice_id: string | null;
    captured: string | null;
    released: string | null;
    remainder_released: boolean;
    settled_at: string | null;
    error: string | null;
  };
  note: string;
  /** sha256 of the canonical JSON of every other field. */
  receipt_sha256: string;
}

const SETTLEMENT: Record<SessionStatus, Receipt['settlement']['status']> = {
  pending_approval: 'not_approved',
  cancelled: 'not_approved',
  active: 'open',
  closing: 'open',
  settled: 'captured',
  voided: 'voided',
  settlement_failed: 'failed',
};

export function buildReceipt(s: SessionRow, calls: readonly CallRow[], env: PayPalEnv): Receipt {
  const charged = calls.filter((c) => c.status === 'OK').reduce((a, c) => a + c.price_cents, 0);
  const captured = s.status === 'settled' ? (s.captured_cents ?? 0) : s.status === 'voided' ? 0 : null;
  const body: Omit<Receipt, 'receipt_sha256'> = {
    kind: 'metermcp.session_receipt',
    version: 1,
    paypal_env: env,
    session: { id: s.id, status: s.status, currency: s.currency, created_at: s.created_at, closed_at: s.closed_at },
    mandate: {
      item: SESSION_ITEM_NAME,
      category: 'DIGITAL_GOODS',
      cap: fromCents(s.cap_cents),
      order_id: s.order_id,
      authorization_id: s.authorization_id,
      authorization_status: s.authorization_status,
      authorization_expires_at: s.authorization_expires_at,
      approved_at: s.approved_at,
      authorized_at: s.authorized_at,
    },
    calls: calls.map((c) => ({
      n: c.n,
      time: c.time,
      tool: c.tool,
      price: fromCents(c.price_cents),
      status: c.status,
      request_hash: c.request_hash,
      response_hash: c.response_hash,
      error: c.error,
    })),
    totals: {
      calls: calls.length,
      ok: calls.filter((c) => c.status === 'OK').length,
      failed: calls.filter((c) => c.status === 'FAILED').length,
      pending: calls.filter((c) => c.status === 'PENDING').length,
      charged: fromCents(charged),
      cap: fromCents(s.cap_cents),
    },
    settlement: {
      status: SETTLEMENT[s.status],
      capture_id: s.capture_id,
      capture_status: s.capture_status,
      invoice_id: s.status === 'settled' ? `${s.id}-settle` : null,
      captured: captured == null ? null : fromCents(captured),
      released: captured == null ? null : fromCents(s.cap_cents - captured),
      remainder_released: s.status === 'settled' || s.status === 'voided',
      settled_at: s.settled_at,
      error: s.settlement_error,
    },
    note: `Tool outputs are synthetic demo data. The budget approval, authorization and ${s.status === 'voided' ? 'void' : 'capture'} are real PayPal ${env} transactions. Failed calls are never charged.`,
  };
  return { ...body, receipt_sha256: sha256(canonicalJson(body)) };
}

const short = (h: string | null) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : '—');

/** The receipt as text lines for the PDF (and for anyone reading it without tools). */
export function receiptLines(r: Receipt): string[] {
  const m = r.mandate;
  const st = r.settlement;
  const cur = r.session.currency;
  return [
    `Session ${r.session.id} · status ${r.session.status} · PayPal ${r.paypal_env}`,
    '',
    'MANDATE',
    `Item: ${m.item} (${m.category})`,
    `Approved budget (hard cap): ${m.cap} ${cur}`,
    `PayPal order: ${m.order_id ?? '—'}`,
    `PayPal authorization: ${m.authorization_id ?? '—'}${m.authorization_status ? ` · ${m.authorization_status}` : ''}`,
    `Approved at: ${m.approved_at ?? '—'} · authorized by PayPal at ${m.authorized_at ?? '—'}`,
    '',
    `CALLS (${r.totals.calls}: ${r.totals.ok} OK, ${r.totals.failed} failed)`,
    ...r.calls.map(
      (c) =>
        `#${c.n} ${c.time} ${c.tool} ${c.price} ${cur} ${c.status === 'OK' ? 'OK' : c.status === 'FAILED' ? 'FAILED (not charged)' : 'PENDING'} · request ${short(c.request_hash)}${c.response_hash ? ` · response ${short(c.response_hash)}` : ''}`,
    ),
    ...r.calls.map((c) => `   #${c.n} request sha256 ${c.request_hash}`),
    '',
    'TOTALS',
    `Charged (OK calls only): ${r.totals.charged} ${cur} of ${r.totals.cap} ${cur}`,
    '',
    'SETTLEMENT',
    st.status === 'captured'
      ? `Captured ${st.captured} ${cur} · PayPal capture ${st.capture_id} (${st.capture_status ?? '?'}) · invoice ${st.invoice_id}`
      : st.status === 'voided'
        ? `Nothing consumed · authorization voided (${m.authorization_status ?? '?'})`
        : st.status === 'failed'
          ? `Settlement failed, not charged: ${st.error ?? '?'}`
          : `Not settled yet (${st.status})`,
    ...(st.remainder_released ? [`Remainder released: ${st.released} ${cur}`] : []),
    ...(st.settled_at ? [`Settled at ${st.settled_at}`] : []),
    '',
    r.note,
    `Receipt sha256 ${r.receipt_sha256}`,
  ];
}

export function receiptPdf(r: Receipt): Uint8Array {
  return writePdf({ header: `MeterMCP session receipt · PayPal ${r.paypal_env}`, title: `Session ${r.session.id}`, lines: receiptLines(r) });
}
