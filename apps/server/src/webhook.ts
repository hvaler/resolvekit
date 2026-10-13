/**
 * POST /api/paypal/webhook/<key> (hosted mode only): PayPal's notifications for the seller's app (CUSTOMER.DISPUTE.*).
 *
 * Outside the browser rules (no session, no Origin: PayPal is the caller), so nothing is believed until PayPal itself
 * confirms the delivery (packages/paypal webhooks.ts: verify-webhook-signature with the raw body). Then the event is
 * only a hint: the handler answers 200 at once and the app reads the dispute again from the API (app.ts). Each event
 * id is acted on once; a repeat delivery is acknowledged without effect.
 *
 * Every confirmation is a call to PayPal under the seller's app, so a stranger must not be able to cause one: the URL
 * PayPal was given carries a secret key (PAYPAL_WEBHOOK_KEY), checked before the body is read; the headers are
 * checked next; only a dispute event is sent for confirmation; and confirmations are capped (per minute and in flight)
 * across all callers, beyond the per-IP limit of the route.
 *
 * Answers: 200 accepted, repeated or not a dispute event · 400 unusable or not signed by PayPal · 404 wrong key ·
 * 408 body too slow · 413 too large · 503 PayPal could not confirm it now, or too many at once (PayPal delivers again
 * later, up to 25 times over 3 days).
 */
import { KeyedLimiter, sameSecret } from '@resolvekit/hosting';
import { parseWebhookEvent, webhookTransmission, type PayPalClient, type WebhookEvent } from '@resolvekit/paypal';
import { json } from './app.ts';

export const WEBHOOK_PREFIX = '/api/paypal/webhook/';
/** Dispute notifications are a few kB; anything far larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 10_000;
/** Event ids remembered to recognise repeat deliveries (PayPal retries for 3 days). */
const MAX_SEEN = 2000;
const DISPUTE_ID = /^PP-[A-Z0-9-]{4,40}$/;
/** The key in the URL: long and URL-safe (generated once, e.g. 32 random bytes as hex). */
export const WEBHOOK_KEY = /^[A-Za-z0-9_-]{32,128}$/;

export interface WebhookOptions {
  paypal: Pick<PayPalClient, 'webhooks'>;
  /** The id PayPal gave this webhook when it was registered on the seller's app (PAYPAL_WEBHOOK_ID). */
  webhookId: string;
  /** The secret path segment of the registered URL (PAYPAL_WEBHOOK_KEY). */
  key: string;
  /** Called after the 200 is decided, without being awaited by PayPal's request. */
  onEvent: (e: WebhookEvent) => Promise<void>;
  log?: (line: string) => void;
  /** Confirmations asked of PayPal, across all callers. */
  verifyLimit?: { perMinute: number; inFlight: number };
  now?: () => number;
}

class TooSlow extends Error {}

/** The body as text, or null when it is larger than `max` bytes (stops reading there). Throws TooSlow past the deadline. */
async function readLimited(req: Request, max: number, timeoutMs: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The handler for `WEBHOOK_PREFIX + key`; any other key is answered 404 before anything is read. */
export function createWebhookHandler(o: WebhookOptions): (req: Request, key: string) => Promise<Response> {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => Date.now());
  const seen = new Set<string>();
  const remember = (id: string) => {
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  };
  const cap = o.verifyLimit ?? { perMinute: 60, inFlight: 4 };
  const perMinute = new KeyedLimiter({ limit: cap.perMinute, windowMs: 60_000, now });
  let inFlight = 0;

  return async (req: Request, key: string): Promise<Response> => {
    if (!sameSecret(key, o.key)) return json(404, { error: 'NOT_FOUND' });
    if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    const t = webhookTransmission(req.headers);
    if ('error' in t) {
      log(`paypal webhook · refused · ${t.error}`);
      return json(400, { error: 'BAD_TRANSMISSION' });
    }
    let raw: string | null;
    try {
      raw = await readLimited(req, MAX_BODY_BYTES, READ_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof TooSlow) return json(408, { error: 'TOO_SLOW' });
      throw e;
    }
    if (raw == null) return json(413, { error: 'TOO_LARGE' });
    // Parsed first so that only a JSON object is ever spliced into the verification request.
    const event = parseWebhookEvent(raw);
    if (!event || !raw.trimStart().startsWith('{')) {
      log('paypal webhook · refused · not a webhook event');
      return json(400, { error: 'NOT_AN_EVENT' });
    }
    // Only dispute events are worth a confirmation; the webhook is registered for nothing else.
    const disputeId = event.resource?.dispute_id;
    if (!event.event_type.startsWith('CUSTOMER.DISPUTE.') || typeof disputeId !== 'string' || !DISPUTE_ID.test(disputeId)) {
      return json(200, { ok: true, ignored: true });
    }
    if (seen.has(event.id)) return json(200, { ok: true, repeated: true });
    if (inFlight >= cap.inFlight || !perMinute.take('all').ok) {
      log(`paypal webhook · ${event.id} · too many confirmations at once · PayPal will deliver again`);
      return json(503, { error: 'BUSY' });
    }
    let verified: boolean;
    inFlight++;
    try {
      verified = await o.paypal.webhooks.verify(t, o.webhookId, raw);
    } catch (e) {
      log(`paypal webhook · ${event.id} · PayPal could not confirm it now (${e instanceof Error ? e.message : 'error'}) · PayPal will deliver again`);
      return json(503, { error: 'VERIFY_UNAVAILABLE' });
    } finally {
      inFlight--;
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
