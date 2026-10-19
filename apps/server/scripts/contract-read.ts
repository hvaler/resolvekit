/**
 * `npm run contract:read` — read-only PayPal sandbox reads for the dispute-action contracts (B, [A2]).
 *
 *   npm run contract:read -- --list | --dispute <PP-…> | --refund <id> [--out <file>]
 *
 * GET only: the PayPal client's fetch is wrapped in {@link getOnly}, which lets through GET and the OAuth token
 * request and refuses anything else before it reaches the network. What is printed and saved is {@link redact}ed:
 * no names, emails, addresses, phone numbers, buyer text or payer ids other than the seller's. Sandbox dispute,
 * capture and refund ids are kept. Credentials come from .env (node --env-file-if-exists) and are never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PayPalClient, PayPalError, type Dispute } from '@resolvekit/paypal';
import { parseBindingPools } from '../src/bindings.ts';

/** The only host a token request may go to: this script reads the sandbox only. */
const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
const ONLY_GET = 'contract-read: only GET reads are allowed';

function requestOf(input: string | URL | Request, init?: RequestInit): { method: string; url: URL | null } {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return { method, url: new URL(raw) };
  } catch {
    return { method, url: null };
  }
}

/**
 * A fetch that sends only GET, and the OAuth token POST (exactly `/v1/oauth2/token` on the sandbox API host). Every
 * other request, and any URL that cannot be parsed, is refused with `contract-read: only GET reads are allowed`
 * before the network is touched. Redirects are errors: a redirected request could reach another route or method.
 */
export function getOnly(f: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { method, url } = requestOf(input, init);
    if (url === null) throw new Error(ONLY_GET);
    const token = method === 'POST' && url.hostname === SANDBOX_HOST && url.pathname === '/v1/oauth2/token';
    if (method !== 'GET' && !token) throw new Error(ONLY_GET);
    return f(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
}

const DROP = new Set(['email', 'email_address', 'name', 'given_name', 'surname', 'full_name', 'phone', 'phone_number', 'phone_details', 'tax_info', 'birth_date']);
const BUYER_TEXT = new Set(['content', 'notes', 'note']);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const buyerText = (s: string) => `<buyer message, ${s.length} chars>`;

/** The seller's merchant ids named anywhere in the document (`seller.merchant_id`). */
function sellerIds(d: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(d)) for (const v of d) sellerIds(v, out);
  else if (isRecord(d)) {
    for (const [k, v] of Object.entries(d)) {
      if (k === 'seller' && isRecord(v) && typeof v.merchant_id === 'string') out.add(v.merchant_id);
      sellerIds(v, out);
    }
  }
  return out;
}

/** Written by the buyer: a message posted by the buyer, the buyer's evidence or supporting info, a buyer offer event. */
const byBuyer = (o: Record<string, unknown>, parentKey: string | null) =>
  o.posted_by === 'BUYER' || o.actor === 'BUYER' || (typeof o.source === 'string' && o.source.includes('BUYER')) || parentKey === 'communication_details';

/**
 * A copy without personal data: every name, email, phone and address field is removed; payer ids are removed unless
 * they are the seller's; text the buyer wrote becomes `<buyer message, N chars>`. Ids, amounts, times, types,
 * statuses and links stay, and so does the seller's own text (it is what a read-back proof compares).
 */
export function redact(d: unknown): unknown {
  const sellers = sellerIds(d);
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (!isRecord(v)) return v;
    const buyer = byBuyer(v, key);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.has(k) || /address/i.test(k)) continue;
      if (k === 'payer_id' && !(typeof x === 'string' && sellers.has(x))) continue;
      if (buyer && BUYER_TEXT.has(k) && typeof x === 'string') {
        out[k] = buyerText(x);
        continue;
      }
      out[k] = walk(x, k);
    }
    return out;
  };
  return walk(d, null);
}

export type ReadArgs = { kind: 'list'; out: string | null } | { kind: 'dispute' | 'refund'; id: string; out: string | null };

const DISPUTE_ID = /^PP-[A-Z0-9-]{3,60}$/;
const REFUND_ID = /^[A-Z0-9]{6,40}$/;

export function parseArgs(argv: string[]): ReadArgs | { error: string } {
  const usage = { error: 'usage: npm run contract:read -- --list | --dispute <PP-…> | --refund <id> [--out <file>]' };
  let kind: ReadArgs['kind'] | null = null;
  let id: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out') {
      out = argv[++i] ?? null;
      if (!out) return usage;
    } else if (a === '--list' || a === '--dispute' || a === '--refund') {
      if (kind) return usage;
      kind = a.slice(2) as ReadArgs['kind'];
      if (kind !== 'list') {
        id = argv[++i] ?? null;
        if (!id || !(kind === 'dispute' ? DISPUTE_ID : REFUND_ID).test(id)) return { error: `${a} needs a ${kind === 'dispute' ? 'dispute id (PP-…)' : 'refund id'}` };
      }
    } else return usage;
  }
  if (!kind) return usage;
  return kind === 'list' ? { kind, out } : { kind, id: id!, out };
}

const say = (s: string) => console.log(`[contract:read] ${s}`);

/** Which case of the local BINDINGS_JSON names each dispute (active or reserve): those are never write targets. */
function boundDisputes(): Map<string, string> {
  const out = new Map<string, string>();
  const raw = process.env.BINDINGS_JSON;
  if (!raw) return out;
  try {
    const p = parseBindingPools(JSON.parse(raw));
    for (const [k, b] of Object.entries(p.bindings)) out.set(b.dispute, `${k} active`);
    for (const [k, list] of Object.entries(p.reserve)) list.forEach((b, i) => out.set(b.dispute, `${k} reserve #${i + 1}`));
  } catch (e) {
    say(`BINDINGS_JSON unreadable (${e instanceof Error ? e.message : String(e)}): bound disputes not marked`);
  }
  return out;
}

const rels = (d: { links?: Array<{ rel: string }> }) => (d.links ?? []).map((l) => l.rel).join(',') || '-';

function describeDispute(d: Dispute & Record<string, unknown>): string[] {
  const msgs = (d.messages as Array<{ posted_by?: string }> | undefined) ?? [];
  const by = (who: string) => msgs.filter((m) => m.posted_by === who).length;
  const offer = d.offer as { history?: unknown[]; offer_type?: string } | undefined;
  const ev = (d.evidences ?? []).map((e) => `${e.source ?? '?'}:${e.evidence_type}${(e as { dispute_life_cycle_stage?: string }).dispute_life_cycle_stage ? `@${(e as { dispute_life_cycle_stage?: string }).dispute_life_cycle_stage}` : ''}`);
  const out = d.dispute_outcome as { outcome_code?: string; amount_refunded?: { value: string; currency_code: string } } | undefined;
  return [
    `${d.dispute_id} · ${d.reason} · ${d.status} · ${d.dispute_life_cycle_stage} · ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code} · channel ${String(d.dispute_channel ?? '-')}`,
    `links: ${rels(d)}`,
    `allowed_response_options: ${JSON.stringify(d.allowed_response_options ?? null)}`,
    `messages: ${msgs.length} (BUYER ${by('BUYER')}, SELLER ${by('SELLER')}, ARBITER ${by('ARBITER')}) · offer: ${offer ? `${offer.offer_type ?? '-'}, history ${offer.history?.length ?? 0}` : 'none'}`,
    `evidences: ${ev.join(' ') || 'none'}`,
    `adjudications: ${JSON.stringify(d.adjudications ?? [])} · outcome: ${out ? `${out.outcome_code}${out.amount_refunded ? ` refunded ${out.amount_refunded.value} ${out.amount_refunded.currency_code}` : ''}` : 'none'}`,
    `refund_details: ${JSON.stringify(d.refund_details ?? null)} · supporting_info: ${(d.supporting_info as unknown[] | undefined)?.length ?? 0}`,
  ];
}

function save(out: string | null, data: unknown) {
  if (!out) return;
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  say(`saved (redacted) to ${path}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if ('error' in a) {
    console.error(a.error);
    process.exitCode = 2;
    return;
  }
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (.env)');
  if ((process.env.PAYPAL_ENV ?? 'sandbox') !== 'sandbox') throw new Error('contract:read only reads the PayPal sandbox (PAYPAL_ENV=sandbox)');
  const paypal = new PayPalClient({ clientId, clientSecret, env: 'sandbox', timeoutMs: 30_000, fetch: getOnly(globalThis.fetch.bind(globalThis)) });

  const route = a.kind === 'list' ? '/v1/customer/disputes?page_size=50' : a.kind === 'dispute' ? `/v1/customer/disputes/${a.id}` : `/v2/payments/refunds/${a.id}`;
  let body: unknown;
  try {
    body = await paypal.request('GET', route);
  } catch (e) {
    if (e instanceof PayPalError) say(`GET ${route} → ${e.status} (${e.message})`);
    throw e;
  }
  say(`GET ${route} → 200 · read at ${new Date().toISOString()}`);
  const clean = redact(body);
  if (a.kind === 'list') {
    const bound = boundDisputes();
    const items = ((clean as { items?: Array<Dispute & Record<string, unknown>> }).items ?? []);
    say(`${items.length} dispute(s)${(clean as { links?: Array<{ rel: string }> }).links?.some((l) => l.rel === 'next') ? ' (more pages exist; not read)' : ''}${bound.size ? ` · ${bound.size} bound in the local BINDINGS_JSON` : ' · local BINDINGS_JSON not set'}`);
    for (const d of items) {
      console.log(`  ${d.dispute_id} · ${d.reason} · ${d.status} · ${d.dispute_life_cycle_stage} · ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code} · created ${d.create_time} · updated ${String(d.update_time ?? '-')}${bound.has(d.dispute_id!) ? ` · BOUND ${bound.get(d.dispute_id!)}` : ''}`);
    }
  } else if (a.kind === 'dispute') {
    const bound = boundDisputes().get(a.id);
    for (const l of describeDispute(clean as Dispute & Record<string, unknown>)) console.log(`  ${l}`);
    if (bound) say(`${a.id} is BOUND in the local BINDINGS_JSON (${bound}): never a write target`);
  } else {
    const r = clean as { id?: string; status?: string; amount?: { value: string; currency_code: string }; links?: Array<{ rel: string; href?: string }> };
    console.log(`  ${r.id} · ${r.status} · ${r.amount?.value} ${r.amount?.currency_code} · links ${(r.links ?? []).map((l) => `${l.rel}=${l.href ?? ''}`).join(' ')}`);
  }
  save(a.out, clean);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[contract:read] failed: ${e instanceof PayPalError ? e.message : e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
