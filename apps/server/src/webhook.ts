/**
 * POST /api/paypal/webhook (hosted mode only): PayPal's notifications for the seller's app (CUSTOMER.DISPUTE.*).
 *
 * Outside the browser rules (no session, no Origin: PayPal is the caller), so nothing is believed until PayPal itself
 * confirms the delivery (packages/paypal webhooks.ts: verify-webhook-signature with the raw body). Then the event is
 * only a hint: the handler answers 200 at once and the app reads the dispute again from the API (app.ts). Each event
 * id is acted on once; a repeat delivery is acknowledged without effect.
 *
 * Answers: 200 accepted or repeated · 400 unusable or not signed by PayPal · 413 too large · 503 PayPal could not
 * confirm it now (PayPal delivers again later, up to 25 times over 3 days).
 */
import { parseWebhookEvent, webhookTransmission, type PayPalClient, type WebhookEvent } from '@resolvekit/paypal';
import { json, type Handler } from './app.ts';

export const WEBHOOK_PATH = '/api/paypal/webhook';
/** Dispute notifications are a few kB; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;
/** Event ids remembered to recognise repeat deliveries (PayPal retries for 3 days). */
const MAX_SEEN = 2000;

export interface WebhookOptions {
  paypal: Pick<PayPalClient, 'webhooks'>;
  /** The id PayPal gave this webhook when it was registered on the seller's app (PAYPAL_WEBHOOK_ID). */
  webhookId: string;
  /** Called after the 200 is decided, without being awaited by PayPal's request. */
  onEvent: (e: WebhookEvent) => Promise<void>;
  log?: (line: string) => void;
}

/** The body as text, or null when it is larger than `max` bytes (stops reading there). */
async function readLimited(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createWebhookHandler(o: WebhookOptions): Handler {
  const log = o.log ?? (() => {});
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    const raw = await readLimited(req, MAX_BODY_BYTES);
    if (raw == null) return json(413, { error: 'TOO_LARGE' });
    const t = webhookTransmission(req.headers);
    if ('error' in t) {
      log(`paypal webhook · refused · ${t.error}`);
      return json(400, { error: 'BAD_TRANSMISSION' });
    }
    // Parsed first so that only a JSON object is ever spliced into the verification request.
    const event = parseWebhookEvent(raw);
    if (!event || !raw.trimStart().startsWith('{')) {
      log('paypal webhook · refused · not a webhook event');
      return json(400, { error: 'NOT_AN_EVENT' });
    }
    if (seen.has(event.id)) return json(200, { ok: true, repeated: true });
    let verified: boolean;
    try {
      verified = await o.paypal.webhooks.verify(t, o.webhookId, raw);
    } catch (e) {
      log(`paypal webhook · ${event.id} · PayPal could not confirm it now (${e instanceof Error ? e.message : 'error'}) · PayPal will deliver again`);
      return json(503, { error: 'VERIFY_UNAVAILABLE' });
    }
    if (!verified) {
      log(`paypal webhook · ${event.id} · REJECTED: PayPal did not confirm the signature`);
      return json(400, { error: 'NOT_VERIFIED' });
    }
    if (seen.has(event.id)) return json(200, { ok: true, repeated: true });
    remember(event.id);
    log(`paypal webhook · ${event.id} · ${event.event_type} · verified`);
    void o.onEvent(event).catch((e) => log(`paypal webhook · ${event.id} · handling failed (${e instanceof Error ? e.message : 'error'})`));
    return json(200, { ok: true });
  };
}
