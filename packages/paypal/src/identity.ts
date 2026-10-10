import type { PayPalClient } from './client.ts';

// Who is this PayPal account? Billing Agreements v1, used only to identify the account that approves; nothing is
// charged and no agreement is created. Verified in the sandbox on 2026-10-10 (PayPalAI evidencia/paypal-acuerdo-*):
// the platform's app creates an agreement token, the merchant approves it on PayPal, and the token then reads
// token_status APPROVED with payer_info.payer_id, which for a business account is its merchant id (equal to
// seller.merchant_id on its disputes). Log in with PayPal's userinfo answered 400 in the same sandbox, and a seller
// cannot approve a token of its own app, so the token must come from a different app than the one that reads the
// seller's disputes.

export interface AgreementTokenStart {
  tokenId: string;
  /** Where the merchant approves (PayPal). */
  approvalUrl: string;
}

export interface ApprovedPayer {
  payerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  countryCode: string | null;
}

/** An agreement token as read back: its status and, once approved, who approved it. */
export interface AgreementTokenState {
  tokenId: string;
  /** PENDING until the payer approves, then APPROVED. */
  status: string;
  payer: ApprovedPayer | null;
}

interface RawToken {
  token_id?: string;
  token_status?: string;
  links?: Array<{ rel: string; href: string }>;
  payer_info?: { payer_id?: string; email?: string; first_name?: string; last_name?: string; country_code?: string };
}

const TOKEN_ID = /^BA-[A-Z0-9]{8,32}$/;

/** Whether a string has the shape of an agreement token id (a value read from a redirect is checked before use). */
export function isAgreementTokenId(s: unknown): s is string {
  return typeof s === 'string' && TOKEN_ID.test(s);
}

export class IdentityApi {
  private readonly client: PayPalClient;

  constructor(client: PayPalClient) {
    this.client = client;
  }

  /** A no-charge agreement token for the account to approve. `description` is shown to it on PayPal. */
  async start(o: { returnUrl: string; cancelUrl: string; description: string }): Promise<AgreementTokenStart> {
    const r = await this.client.request<RawToken>('POST', '/v1/billing-agreements/agreement-tokens', {
      description: o.description,
      payer: { payment_method: 'PAYPAL' },
      plan: {
        type: 'MERCHANT_INITIATED_BILLING',
        merchant_preferences: { return_url: o.returnUrl, cancel_url: o.cancelUrl, accepted_pymt_type: 'INSTANT', skip_shipping_address: true, immutable_shipping_address: false },
      },
    });
    const approvalUrl = r.links?.find((l) => l.rel === 'approval_url')?.href;
    if (!isAgreementTokenId(r.token_id) || !approvalUrl) throw new Error('PayPal returned no agreement token or approval link');
    return { tokenId: r.token_id, approvalUrl };
  }

  /** Read the token back: `payer` is set only when it is APPROVED and PayPal names the payer. */
  async read(tokenId: string): Promise<AgreementTokenState> {
    if (!isAgreementTokenId(tokenId)) throw new Error('not an agreement token id');
    const r = await this.client.request<RawToken>('GET', `/v1/billing-agreements/agreement-tokens/${encodeURIComponent(tokenId)}`);
    const p = r.payer_info;
    const status = r.token_status ?? 'UNKNOWN';
    const payer =
      status === 'APPROVED' && p?.payer_id
        ? { payerId: p.payer_id, email: p.email ?? null, firstName: p.first_name ?? null, lastName: p.last_name ?? null, countryCode: p.country_code ?? null }
        : null;
    return { tokenId, status, payer };
  }
}
