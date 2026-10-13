import { RawJson, type PayPalClient } from './client.ts';

// Webhook notifications (CUSTOMER.DISPUTE.*). A notification is only a hint that something changed: it is verified
// with PayPal (POST /v1/notifications/verify-webhook-signature, as PayPal recommends) and then the dispute is read
// again from the API; nothing in the payload is trusted for what it says about the dispute. The event goes to PayPal
// exactly as it arrived (its raw bytes), so the check never depends on how this server would re-serialise it.

/** The transmission headers PayPal sends with every webhook delivery. */
export interface WebhookTransmission {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

const HEADERS = {
  authAlgo: 'paypal-auth-algo',
  certUrl: 'paypal-cert-url',
  transmissionId: 'paypal-transmission-id',
  transmissionSig: 'paypal-transmission-sig',
  transmissionTime: 'paypal-transmission-time',
} as const;

/** PayPal's certificate hosts: a cert URL anywhere else is refused before asking PayPal. */
const CERT_HOSTS = new Set(['api.paypal.com', 'api.sandbox.paypal.com', 'api-m.paypal.com', 'api-m.sandbox.paypal.com']);

/** The transmission headers, or why they are not usable (missing, oversized, or a certificate not on PayPal's hosts). */
export function webhookTransmission(headers: Headers): WebhookTransmission | { error: string } {
  const t = {} as WebhookTransmission;
  for (const [k, h] of Object.entries(HEADERS) as Array<[keyof WebhookTransmission, string]>) {
    const v = headers.get(h)?.trim();
    if (!v) return { error: `missing ${h}` };
    if (v.length > 2048) return { error: `${h} too long` };
    t[k] = v;
  }
  let cert: URL;
  try {
    cert = new URL(t.certUrl);
  } catch {
    return { error: 'paypal-cert-url is not a URL' };
  }
  if (cert.protocol !== 'https:' || !CERT_HOSTS.has(cert.hostname)) return { error: 'paypal-cert-url is not on a PayPal host' };
  return t;
}

/** A webhook event as far as this app reads it (after verification). */
export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  summary?: string;
  resource?: { dispute_id?: string; status?: string; [k: string]: unknown };
}

const EVENT_ID = /^WH-[A-Za-z0-9-]{8,64}$/;

/** The event's id, type and dispute id, or null when the JSON is not a webhook event this app understands. */
export function parseWebhookEvent(raw: string): WebhookEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  const ev = e as WebhookEvent;
  if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !EVENT_ID.test(ev.id) || typeof ev.event_type !== 'string') return null;
  return ev;
}

export class WebhooksApi {
  private readonly c: PayPalClient;
  constructor(c: PayPalClient) {
    this.c = c;
  }

  /**
   * Whether PayPal confirms this delivery was signed by PayPal for `webhookId`. `rawEvent` is the request body exactly
   * as received. Throws PayPalError when PayPal cannot answer (the caller asks PayPal to deliver again).
   */
  async verify(t: WebhookTransmission, webhookId: string, rawEvent: string): Promise<boolean> {
    const head = JSON.stringify({
      auth_algo: t.authAlgo,
      cert_url: t.certUrl,
      transmission_id: t.transmissionId,
      transmission_sig: t.transmissionSig,
      transmission_time: t.transmissionTime,
      webhook_id: webhookId,
    });
    // `{...head fields, "webhook_event": <raw bytes>}`: the event is spliced in, not re-serialised.
    const body = `${head.slice(0, -1)},"webhook_event":${rawEvent}}`;
    const r = await this.c.request<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', new RawJson(body));
    return r.verification_status === 'SUCCESS';
  }
}
