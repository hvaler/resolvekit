/**
 * The small HTTP helpers the API (app.ts) and the action routes (actions/routes.ts) share: one JSON answer, one body
 * reader, one way to tell a timeout, one short reason for a PayPal failure and one 429. Never any request header,
 * token or credential in what they return.
 */
import { PayPalError } from '@resolvekit/paypal';

/** A JSON answer, never cached. */
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** The request's JSON body, or the 400 INVALID_JSON answer. */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: await req.json() };
  } catch {
    return { ok: false, res: json(400, { error: 'INVALID_JSON' }) };
  }
}

/** A fetch that timed out or was aborted. */
export const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** PayPal's issue code (e.g. EVIDENCE_TYPE_IS_NOT_ALLOWED), else its error name, if it gave one. */
export function paypalIssue(e: PayPalError): string | undefined {
  const b = e.body as { name?: string; details?: Array<{ issue?: string }> } | null;
  return b?.details?.find((d) => d.issue)?.issue ?? b?.name ?? undefined;
}

/** A short reason for the audit log and the trail: codes and PayPal's debug_id, never message or document text. */
export function failureText(e: unknown): string {
  if (e instanceof PayPalError) return `PayPal ${e.status}${paypalIssue(e) ? ` ${paypalIssue(e)}` : ''}${e.debugId ? ` · debug_id ${e.debugId}` : ''}`;
  return isTimeout(e) ? 'PayPal timed out' : 'PayPal unreachable';
}

/** A cap or rate refusal as an answer, with Retry-After when it says when. */
export function tooMany(x: { status: number; error: string; detail: string; retryAfterSec?: number }): Response {
  const r = json(x.status, { error: x.error, detail: x.detail, ...(x.retryAfterSec ? { retryAfterSec: x.retryAfterSec } : {}) });
  if (x.retryAfterSec) r.headers.set('retry-after', String(x.retryAfterSec));
  return r;
}
