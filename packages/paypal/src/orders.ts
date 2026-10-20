import type { PayPalClient } from './client.ts';

// Orders v2 (intent AUTHORIZE) and Payments v2 authorizations, kept to the fields MeterMCP uses. Every shape and
// step below was verified in the sandbox on 2026-10-08: the buyer approves through the payer-action link, the
// order is authorized, a partial capture with final_capture=true closes the authorization (status CAPTURED, the
// remainder released) and an unused authorization can be voided (VOIDED). Authorizations expire after 29 days.

export interface Money { currency_code: string; value: string }
export interface Link { rel: string; href: string; method?: string }

export interface Authorization {
  id: string;
  /** CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED, PENDING (PayPal Server SDK 2.5.0 AuthorizationStatus). */
  status?: string;
  /** Why it is PENDING or DENIED: PENDING_REVIEW, DECLINED_BY_RISK_FRAUD_FILTERS. */
  status_details?: { reason?: string };
  amount?: Money;
  expiration_time?: string;
  create_time?: string;
  update_time?: string;
}

export interface Capture {
  id: string;
  /** COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED (SDK 2.5.0 CaptureStatus). */
  status?: string;
  /** Why it is PENDING or not completed (SDK CaptureIncompleteReason). */
  status_details?: { reason?: string };
  amount?: Money;
  final_capture?: boolean;
  invoice_id?: string;
  create_time?: string;
  update_time?: string;
}

/** A Payments v2 refund (reads/refund-3H730369N6162525E.json): its `up` link is the refunded capture. Read only. */

export interface Order {
  id: string;
  intent?: string;
  /** CREATED, PAYER_ACTION_REQUIRED, APPROVED, COMPLETED, VOIDED… */
  status?: string;
  create_time?: string;
  update_time?: string;
  links?: Link[];
  purchase_units?: Array<{
    custom_id?: string;
    amount?: Money;
    payments?: { authorizations?: Authorization[]; captures?: Capture[] };
  }>;
}

export interface OrderItem {
  name: string;
  description?: string;
  quantity: string;
  unit_amount: Money;
  /** DIGITAL_GOODS, PHYSICAL_GOODS or DONATION. Stored on the order; a dispute's item type is the buyer's pick. */
  category?: 'DIGITAL_GOODS' | 'PHYSICAL_GOODS' | 'DONATION';
}

export interface CreateAuthorizeOrder {
  amount: Money;
  items: OrderItem[];
  customId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
}

/** A plain checkout: the buyer approves, then the merchant captures the whole order at once (Orders v2 CAPTURE). */
export interface CreateCaptureOrder {
  amount: Money;
  items: OrderItem[];
  description: string;
  returnUrl: string;
  cancelUrl: string;
  invoiceId?: string;
  brandName?: string;
  /** Physical goods ship to the buyer's PayPal address (GET_FROM_FILE); default NO_SHIPPING. */
  shipping?: 'GET_FROM_FILE' | 'NO_SHIPPING';
}

/** The capture of a completed CAPTURE order (the payment a buyer can dispute). */
export function orderCapture(o: Order): Capture | null {
  return o.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

/** The link the buyer opens to approve the order (`payer-action`, or `approve` on older answers). */
export function approvalUrl(o: Order): string | null {
  return o.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
}

// As sent in the sandbox checks: JSON content type even without a body, and the full resource in the answer.
const JSON_FULL = { 'Content-Type': 'application/json', Prefer: 'return=representation' };

export class OrdersApi {
  private readonly client: PayPalClient;

  constructor(client: PayPalClient) {
    this.client = client;
  }

  /** An AUTHORIZE order the buyer approves in PayPal; nothing is charged until a capture. */
  createAuthorize(o: CreateAuthorizeOrder, opts: { requestId?: string } = {}): Promise<Order> {
    const body = {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          amount: { ...o.amount, breakdown: { item_total: o.amount } },
          items: o.items,
          custom_id: o.customId,
          description: o.description,
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: o.returnUrl,
            cancel_url: o.cancelUrl,
            user_action: 'CONTINUE',
            shipping_preference: 'NO_SHIPPING',
            ...(o.brandName ? { brand_name: o.brandName } : {}),
          },
        },
      },
    };
    return this.client.request<Order>('POST', '/v2/checkout/orders', body, { ...opts, headers: JSON_FULL });
  }

  /** A CAPTURE order the buyer approves in PayPal; nothing is charged until {@link capture}. */
  createCapture(o: CreateCaptureOrder, opts: { requestId?: string } = {}): Promise<Order> {
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { ...o.amount, breakdown: { item_total: o.amount } },
          items: o.items,
          description: o.description,
          ...(o.invoiceId ? { invoice_id: o.invoiceId } : {}),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: o.returnUrl,
            cancel_url: o.cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: o.shipping ?? 'NO_SHIPPING',
            ...(o.brandName ? { brand_name: o.brandName } : {}),
          },
        },
      },
    };
    return this.client.request<Order>('POST', '/v2/checkout/orders', body, { ...opts, headers: JSON_FULL });
  }

  /** Capture an APPROVED CAPTURE order. The answer holds the capture (see {@link orderCapture}). */
  capture(orderId: string, opts: { requestId?: string } = {}): Promise<Order> {
    return this.client.request<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, undefined, { ...opts, headers: JSON_FULL });
  }

  get(orderId: string): Promise<Order> {
    return this.client.request<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /** Only once the buyer has approved (status APPROVED). The answer holds the authorization. */
  authorize(orderId: string, opts: { requestId?: string } = {}): Promise<Order> {
    return this.client.request<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, undefined, { ...opts, headers: JSON_FULL });
  }
}

export class PaymentsApi {
  private readonly client: PayPalClient;

  constructor(client: PayPalClient) {
    this.client = client;
  }

  /** A capture as PayPal reports it now: PENDING settles later as COMPLETED, or ends DECLINED / FAILED. */
  getCapture(captureId: string): Promise<Capture> {
    return this.client.request<Capture>('GET', `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  getAuthorization(authorizationId: string): Promise<Authorization> {
    return this.client.request<Authorization>('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`);
  }

  /**
   * Capture part (or all) of an authorization. With `finalCapture` the authorization closes and the remainder is
   * released to the buyer. `requestId` (PayPal-Request-Id) makes a retry of the same capture safe on Payments v2.
   */
  captureAuthorization(
    authorizationId: string,
    c: { amount: Money; finalCapture: boolean; invoiceId?: string; noteToPayer?: string },
    opts: { requestId?: string } = {},
  ): Promise<Capture> {
    const body = {
      amount: c.amount,
      final_capture: c.finalCapture,
      ...(c.invoiceId ? { invoice_id: c.invoiceId } : {}),
      ...(c.noteToPayer ? { note_to_payer: c.noteToPayer } : {}),
    };
    return this.client.request<Capture>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, body, { ...opts, headers: JSON_FULL });
  }

  /** Release the whole authorization (nothing is charged). */
  voidAuthorization(authorizationId: string, opts: { requestId?: string } = {}): Promise<Authorization> {
    return this.client.request<Authorization>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`, undefined, { ...opts, headers: JSON_FULL });
  }
}
