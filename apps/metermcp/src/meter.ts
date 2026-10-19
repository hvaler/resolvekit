/**
 * MeterMCP's money logic, independent of MCP and HTTP so it is tested directly with a fake PayPal.
 *
 * One payment session per MCP session: the first paid call without an approved budget answers payment_required
 * with an approval URL (a PayPal Orders v2 AUTHORIZE order for the budget). Once the buyer approves, the order is
 * authorized and the session opens with that hard cap. Each paid call reserves its price in the ledger before the
 * tool runs (refused before forwarding if it would exceed the cap), is charged only if the tool succeeds, and is
 * released if it fails. Closing captures exactly the sum of the OK calls with final_capture (the rest of the
 * authorization is released to the buyer), or voids the authorization when nothing was consumed.
 *
 * A client can also open the budget itself with open_budget, asking for a cap within the demo bounds.
 */
import { randomBytes } from 'node:crypto';
import { approvalUrl, PayPalError, type Authorization, type Order, type PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import { canonicalJson, requestHash, sha256 } from './hash.ts';
import type { Ledger, SessionRow } from './ledger.ts';
import { fromCents, toCents } from './money.ts';
import { SESSION_ITEM_NAME as SESSION_ITEM } from './names.ts';
import { buildReceipt, type Receipt } from './receipt.ts';
import { CURRENCY, PAID_TOOLS, priceList, toolByName, type PaidTool } from './tools.ts';


export interface MeterOptions {
  ledger: Ledger;
  /** null when PayPal credentials are not configured: paid calls then answer paypal_unconfigured. */
  paypal: Pick<PayPalClient, 'orders' | 'payments'> | null;
  env: PayPalEnv;
  /** Where the buyer's browser comes back after PayPal: `${publicUrl}/approved` and `${publicUrl}/cancelled`. */
  publicUrl: string;
  /** The largest budget (default 5.00): the payment_required proposal, and the most open_budget may ask for. */
  budget?: string;
  /** The smallest cap open_budget may ask for (default 0.50). */
  minBudget?: string;
  /**
   * Origins (`https://host[:port]`) an open_budget `return_to` may point at; /approved sends the buyer there once the
   * budget is active. Any other return_to is ignored.
   */
  returnOrigins?: readonly string[];
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Test switch (env METERMCP_FAIL_FIRST): in each session opened through payment_required, the first call of each
   * named tool fails upstream, so the "failed call is not charged" path can be shown. Recorded as such in the
   * receipt. Sessions opened by open_budget follow their own fail_first instead.
   */
  failFirst?: readonly string[];
  newSessionId?: () => string;
}

/** What a tool call answers: an MCP tool result (text content holding JSON). */
export type ToolAnswer = {
  [k: string]: unknown;
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
};

/**
 * Hosted mode: asked synchronously right before a new budget (a PayPal order) would be created. Refuses (demo code
 * missing, daily cap reached) with a tool answer, or reserves one; the reservation is released if the order could not
 * be created. Local mode has none.
 */
export type BudgetGate = () => { ok: true; release: () => void } | { ok: false; answer: ToolAnswer };

export const answer = (body: unknown, isError = false): ToolAnswer => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });

/** Strict money parse: null (never a default) when the value is missing or malformed. */
function cents(value: string | undefined): number | null {
  if (value == null) return null;
  try {
    return toCents(value);
  } catch {
    return null;
  }
}

/**
 * Why an authorized order must NOT open this session, or null when it may. Every check fails closed: the order must
 * be this session's own (order id, and custom_id when PayPal returns it), with exactly one authorization in status
 * CREATED for exactly the session's cap and currency, and a known expiry still in the future.
 */
export function authorizationProblem(s: SessionRow, order: Order, now: Date): string | null {
  if (order.id !== s.order_id) return `order ${order.id} is not this session's order ${s.order_id}`;
  const pu = order.purchase_units?.[0];
  if (pu?.custom_id != null && pu.custom_id !== s.id) return `order custom_id ${pu.custom_id} is not this session`;
  const auths = pu?.payments?.authorizations ?? [];
  if (auths.length !== 1) return `expected one authorization, PayPal reports ${auths.length}`;
  const a: Authorization = auths[0]!;
  if (!a.id) return 'authorization without id';
  if (a.status !== 'CREATED') return `authorization ${a.id} is ${a.status ?? 'without status'}, not CREATED`;
  if (a.amount?.currency_code !== s.currency) return `authorization currency ${a.amount?.currency_code ?? 'missing'} is not ${s.currency}`;
  if (cents(a.amount?.value) !== s.cap_cents) return `authorized amount ${a.amount?.value ?? 'missing'} is not the cap ${fromCents(s.cap_cents)}`;
  const exp = a.expiration_time ? Date.parse(a.expiration_time) : NaN;
  if (!Number.isFinite(exp)) return `authorization ${a.id} has no valid expiration_time`;
  if (exp <= now.getTime()) return `authorization ${a.id} expired at ${a.expiration_time}`;
  return null;
}

const isAnswer = (x: SessionRow | ToolAnswer): x is ToolAnswer => Array.isArray((x as ToolAnswer).content);

export const INJECTED_FAILURE = 'UPSTREAM_UNAVAILABLE (injected by the METERMCP_FAIL_FIRST test switch)';
/** The failure a session opened by open_budget asked for itself (its fail_first). */
export const RUN_INJECTED_FAILURE = "UPSTREAM_UNAVAILABLE (injected for this run at the person's request)";

/** An open_budget cap: whole dollars (1–2 digits) and up to 2 decimals, in {@link CURRENCY}. */
const CAP_FORMAT = /^\d{1,2}(\.\d{1,2})?$/;
const MAX_FAIL_FIRST = 3;

/** The paid tools a session injects failures for: its own list when it has one, else the server switch. */
function failFirstOf(s: SessionRow, serverSwitch: readonly string[]): { tools: readonly string[]; message: string } {
  if (s.fail_first == null) return { tools: serverSwitch, message: INJECTED_FAILURE };
  let tools: unknown;
  try {
    tools = JSON.parse(s.fail_first);
  } catch {
    tools = [];
  }
  return { tools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : [], message: RUN_INJECTED_FAILURE };
}

/** A 422 whose issue is INSTRUMENT_DECLINED: the buyer must choose another funding source in a new approval. */
function isInstrumentDeclined(e: unknown): boolean {
  if (!(e instanceof PayPalError) || e.status !== 422) return false;
  const details = (e.body as { details?: Array<{ issue?: string }> } | null)?.details ?? [];
  return details.some((d) => d.issue === 'INSTRUMENT_DECLINED');
}

function why(e: unknown): string {
  if (e instanceof PayPalError) return e.message;
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'PayPal timed out';
  return e instanceof Error ? e.message : String(e);
}

/**
 * `mm-sess-` + 128 random bits as 32 hex characters (40 characters in all). Unguessable, but never treated as a
 * credential: HTTP routes need the admin token and MCP tools only reach the caller's own session. It also fits
 * every PayPal field it goes into: custom_id (≤127), invoice_id `${id}-settle` (≤127), the dispute evidence
 * tracking number, and PayPal-Request-Id `${id}-authorize` (≤108).
 */
export function newSessionId(): string {
  return `mm-sess-${randomBytes(16).toString('hex')}`;
}

export const SESSION_ID = /^mm-sess-[0-9a-f]{32}$/;

export class Meter {
  private readonly o: Required<Omit<MeterOptions, 'paypal' | 'newSessionId'>> & Pick<MeterOptions, 'paypal'> & { newSessionId: () => string };
  private readonly budgetCents: number;
  private readonly minBudgetCents: number;
  private readonly returnOrigins: ReadonlySet<string>;
  /** One order creation per MCP session at a time; one approval check per payment session at a time. */
  private readonly opening = new Map<string, Promise<SessionRow | ToolAnswer>>();
  private readonly approving = new Map<string, Promise<SessionRow>>();
  private readonly closing = new Map<string, Promise<CloseResult>>();
  private readonly reconciling = new Map<string, Promise<SessionRow | null>>();

  constructor(opts: MeterOptions) {
    const now = opts.now ?? (() => new Date());
    this.o = {
      ...opts,
      budget: opts.budget ?? '5.00',
      minBudget: opts.minBudget ?? '0.50',
      returnOrigins: opts.returnOrigins ?? [],
      log: opts.log ?? (() => {}),
      failFirst: opts.failFirst ?? [],
      now,
      newSessionId: opts.newSessionId ?? newSessionId,
    };
    this.budgetCents = toCents(this.o.budget);
    this.minBudgetCents = toCents(this.o.minBudget);
    this.returnOrigins = new Set(
      this.o.returnOrigins.map((o) => {
        // "localhost:5173" parses with scheme "localhost:" and the opaque origin "null", which javascript: and data:
        // URLs share: such an entry would let them through, so it is refused (main.ts: MeterMCP does not start).
        const u = new URL(o);
        if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin === 'null') throw new Error(`Return origin ${JSON.stringify(o)} is not an http(s) origin`);
        return u.origin;
      }),
    );
  }

  /** The caps open_budget accepts, as decimal strings in {@link CURRENCY}. */
  get capRange(): { min: string; max: string } {
    return { min: fromCents(this.minBudgetCents), max: fromCents(this.budgetCents) };
  }

  /** `url` when it is an absolute URL on one of the allowed return origins, else null. */
  allowedReturn(url: string | null | undefined): string | null {
    if (!url || url.length > 2048) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return this.returnOrigins.has(u.origin) ? u.href : null;
  }

  private iso(): string {
    return this.o.now().toISOString();
  }

  get ledger(): Ledger {
    return this.o.ledger;
  }

  // -------------------------------------------------------------------------------------------
  // Mandate: payment_required → approval → authorization

  private paymentRequired(s: SessionRow, tool: PaidTool | null): ToolAnswer {
    return answer(
      {
        error: 'payment_required',
        message: `Paid MeterMCP tools need a budget approved by the user in PayPal. Ask the user to open approval_url and approve up to ${fromCents(s.cap_cents)} ${s.currency}; nothing is charged until the session closes, and only for successful calls. Then call get_balance (or retry) until status is "active".`,
        ...(tool ? { tool: tool.name, price: tool.price } : {}),
        currency: s.currency,
        budget_proposal: fromCents(s.cap_cents),
        session_id: s.id,
        order_id: s.order_id,
        approval_url: s.approval_url,
        status: s.status,
      },
      true,
    );
  }

  private paymentDeclined(s: SessionRow): ToolAnswer {
    return answer(
      {
        error: 'payment_declined',
        message: 'PayPal declined the budget (the funding source the user chose, or the authorization itself; see reason). Nothing was authorized or charged. Call the tool again to get a new approval_url, and ask the user to choose another funding source in PayPal.',
        session_id: s.id,
        order_id: s.order_id,
        reason: s.settlement_error,
        status: s.status,
      },
      true,
    );
  }

  /** The MCP session's payment session, creating it (and its PayPal order) when there is none. */
  private async sessionFor(mcpSession: string, gate?: BudgetGate): Promise<SessionRow | ToolAnswer> {
    const inFlight = this.opening.get(mcpSession);
    if (inFlight) return inFlight;
    const existing = this.o.ledger.openSessionFor(mcpSession);
    if (existing) return existing.status === 'pending_approval' ? this.checkApproval(existing) : existing;
    return this.beginOpening(mcpSession, gate, this.budgetCents, { failFirst: null, returnTo: null });
  }

  /**
   * Reserve a budget with the gate and start creating it, registered in `opening`. Synchronous up to the
   * registration (callers check `opening` and the ledger right before, with no await in between): one budget per
   * MCP session at a time, and concurrent sessions cannot overshoot the gate's cap.
   */
  private beginOpening(mcpSession: string, gate: BudgetGate | undefined, capCents: number, extra: { failFirst: string[] | null; returnTo: string | null }): Promise<SessionRow | ToolAnswer> {
    const reserved = gate?.();
    if (reserved && !reserved.ok) return Promise.resolve(reserved.answer);
    const p = this.openSession(mcpSession, capCents, extra)
      .then((r) => {
        if (isAnswer(r) && reserved?.ok) reserved.release(); // no order was created: refund
        return r;
      })
      .finally(() => this.opening.delete(mcpSession));
    this.opening.set(mcpSession, p);
    return p;
  }

  private async openSession(mcpSession: string, capCents: number, extra: { failFirst: string[] | null; returnTo: string | null }): Promise<SessionRow | ToolAnswer> {
    const paypal = this.o.paypal;
    if (!paypal) return answer({ error: 'paypal_unconfigured', message: 'MeterMCP has no PayPal credentials (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).' }, true);
    const id = this.o.newSessionId();
    const amount = { currency_code: CURRENCY, value: fromCents(capCents) };
    this.o.ledger.createSession({ id, mcpSession, currency: CURRENCY, capCents, now: this.iso(), ...extra });
    try {
      const order = await paypal.orders.createAuthorize(
        {
          amount,
          items: [{ name: SESSION_ITEM, description: `Budget for paid MCP tool calls, max ${amount.value} ${CURRENCY}`, quantity: '1', unit_amount: amount, category: 'DIGITAL_GOODS' }],
          customId: id,
          description: `MeterMCP agent session ${id} (max ${amount.value} ${CURRENCY})`,
          returnUrl: `${this.o.publicUrl}/approved`,
          cancelUrl: `${this.o.publicUrl}/cancelled`,
          brandName: 'MeterMCP',
        },
        { requestId: `${id}-order` },
      );
      const url = approvalUrl(order);
      if (!url) throw new Error(`PayPal order ${order.id} has no approval link`);
      this.o.ledger.setOrder(id, order.id, url);
      this.o.log(`session ${id}: order ${order.id} created for ${amount.value} ${CURRENCY}, waiting for approval`);
      return this.o.ledger.session(id)!;
    } catch (e) {
      this.o.ledger.cancel(id, this.iso());
      this.o.log(`session ${id}: could not create the PayPal order (${why(e)})`);
      return answer({ error: 'paypal_unavailable', message: `Could not create the PayPal order for the budget: ${why(e)}` }, true);
    }
  }

  /**
   * Ask PayPal whether the buyer approved the order; if so, authorize it and open the session. Safe to call any
   * number of times (deduplicated, and the authorize call carries a stable PayPal-Request-Id).
   */
  checkApproval(s: SessionRow): Promise<SessionRow> {
    if (s.status !== 'pending_approval' || !s.order_id || !this.o.paypal) return Promise.resolve(s);
    const inFlight = this.approving.get(s.id);
    if (inFlight) return inFlight;
    const p = this.approve(s).finally(() => this.approving.delete(s.id));
    this.approving.set(s.id, p);
    return p;
  }

  private async approve(s: SessionRow): Promise<SessionRow> {
    const paypal = this.o.paypal!;
    const orderId = s.order_id!;
    let order: Order;
    try {
      order = await paypal.orders.get(orderId);
      if (order.status === 'APPROVED') order = await paypal.orders.authorize(orderId, { requestId: `${s.id}-authorize` });
    } catch (e) {
      if (isInstrumentDeclined(e)) {
        // The buyer's funding source was refused: this order's authorization is not retried (the same
        // PayPal-Request-Id could only replay the refusal). The session ends; the next paid call asks for a new
        // approval, where the buyer can choose another funding source.
        this.o.ledger.cancel(s.id, this.iso(), `PayPal declined the funding source (INSTRUMENT_DECLINED, ${why(e)})`);
        this.o.log(`session ${s.id}: authorization declined by PayPal, session ended (${why(e)})`);
        return this.o.ledger.session(s.id)!;
      }
      this.o.log(`session ${s.id}: approval check failed (${why(e)})`);
      return this.o.ledger.session(s.id)!;
    }
    if (order.status === 'VOIDED') {
      this.o.ledger.cancel(s.id, this.iso());
      return this.o.ledger.session(s.id)!;
    }
    if (order.status !== 'COMPLETED') return this.o.ledger.session(s.id)!;
    // PayPal can hold the authorization (PENDING, e.g. PENDING_REVIEW: wait, it may become CREATED) or refuse it
    // (DENIED, e.g. DECLINED_BY_RISK_FRAUD_FILTERS: final for this order; the session ends with the reason).
    const held = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    const heldWhy = held?.status_details?.reason ? ` (${held.status_details.reason})` : '';
    if (held?.status === 'DENIED' && order.id === s.order_id) {
      this.o.ledger.cancel(s.id, this.iso(), `PayPal denied the authorization${heldWhy}`);
      this.o.log(`session ${s.id}: authorization ${held.id} DENIED by PayPal${heldWhy}, session ended`);
      return this.o.ledger.session(s.id)!;
    }
    if (held?.status === 'PENDING') {
      this.o.log(`session ${s.id}: authorization ${held.id} PENDING at PayPal${heldWhy}; waiting`);
      return this.o.ledger.session(s.id)!;
    }
    const problem = authorizationProblem(s, order, this.o.now());
    if (problem) {
      // Fail closed: the session stays pending_approval (no paid call can run) and the reason is logged.
      this.o.log(`session ${s.id}: NOT opened, ${problem}`);
      return this.o.ledger.session(s.id)!;
    }
    const auth = order.purchase_units![0]!.payments!.authorizations![0]!;
    const activated = this.o.ledger.activate(s.id, {
      authorizationId: auth.id,
      authorizationStatus: auth.status!,
      expiresAt: auth.expiration_time!,
      approvedAt: this.iso(),
      authorizedAt: auth.create_time ?? null,
    });
    if (!activated) {
      // The session left pending_approval while PayPal authorized (closed, timed out): no session holds this
      // authorization, so release it now instead of leaving a hold nothing will ever settle.
      const now = this.o.ledger.session(s.id)!;
      try {
        const v = await paypal.payments.voidAuthorization(auth.id, { requestId: `${s.id}-void` });
        this.o.log(`session ${s.id}: authorization ${auth.id} arrived after the session was ${now.status}; voided (${v.status ?? 'no status'})`);
      } catch (e) {
        this.o.log(`session ${s.id}: authorization ${auth.id} arrived after the session was ${now.status}; void FAILED (${why(e)}), still held at PayPal`);
      }
      return now;
    }
    this.o.log(`session ${s.id}: approved, authorization ${auth.id} (${auth.status}) · cap ${fromCents(s.cap_cents)} ${s.currency}`);
    return this.o.ledger.session(s.id)!;
  }

  /** The buyer came back from PayPal (`/approved?token=<order id>`). */
  async approvedByOrder(orderId: string): Promise<SessionRow | null> {
    const s = this.o.ledger.sessionByOrder(orderId);
    return s ? this.checkApproval(s) : null;
  }

  /**
   * open_budget: open this MCP session's budget with the cap asked for (within [minBudget, budget]), instead of the
   * payment_required proposal. Same gate and one-at-a-time rule as payment_required. The session injects failures
   * only for its own `failFirst` (none when empty), never the server switch; `returnTo` is kept only when it is on
   * an allowed return origin.
   */
  async openBudget(mcpSession: string, req: { cap: string; failFirst?: string[]; returnTo?: string }, opts: { budgetGate?: BudgetGate } = {}): Promise<ToolAnswer> {
    const { min, max } = this.capRange;
    const capCents = typeof req.cap === 'string' && CAP_FORMAT.test(req.cap) ? toCents(req.cap) : null;
    if (capCents == null || capCents <= 0 || capCents < this.minBudgetCents || capCents > this.budgetCents) {
      return answer({ error: 'invalid_cap', message: `cap must be an amount in ${CURRENCY} from ${min} to ${max} (e.g. "2.50"); got ${JSON.stringify(String(req.cap).slice(0, 20))}. Nothing was opened.`, min, max, currency: CURRENCY }, true);
    }
    const failFirst = [...new Set(req.failFirst ?? [])];
    const unknown = failFirst.find((t) => !toolByName(t));
    if (unknown !== undefined) return answer({ error: 'unknown_tool', tool: unknown, message: `fail_first names only paid tools (${PAID_TOOLS.map((t) => t.name).join(', ')}). Nothing was opened.` }, true);
    if (failFirst.length > MAX_FAIL_FIRST) return answer({ error: 'invalid_fail_first', message: `fail_first names at most ${MAX_FAIL_FIRST} paid tools. Nothing was opened.` }, true);
    // From here to beginOpening, no await: the check and the registration in `opening` are one step.
    const existing = this.o.ledger.openSessionFor(mcpSession);
    if (this.opening.has(mcpSession) || existing) {
      return answer(
        {
          error: 'budget_exists',
          message: 'This MCP session already has a budget (open or waiting for approval); only one at a time. Use get_balance, or close_session first.',
          ...(existing ? { session_id: existing.id, status: existing.status } : {}),
        },
        true,
      );
    }
    const got = await this.beginOpening(mcpSession, opts.budgetGate, capCents, { failFirst, returnTo: this.allowedReturn(req.returnTo) });
    if (isAnswer(got)) return got;
    return answer({ session_id: got.id, order_id: got.order_id, approval_url: got.approval_url, cap: fromCents(got.cap_cents), currency: got.currency, fail_first: failFirst, status: 'pending_approval' });
  }

  // -------------------------------------------------------------------------------------------
  // Paid calls

  async call(mcpSession: string, toolName: string, args: Record<string, unknown>, opts: { budgetGate?: BudgetGate } = {}): Promise<ToolAnswer> {
    const tool = toolByName(toolName);
    if (!tool) return answer({ error: 'unknown_tool', tool: toolName }, true);
    const got = await this.sessionFor(mcpSession, opts.budgetGate);
    if (isAnswer(got)) return got;
    const s = got;
    if (s.status === 'pending_approval') return this.paymentRequired(s, tool);
    if (s.status === 'cancelled') return this.paymentDeclined(s);
    if (s.status !== 'active') {
      return answer({ error: 'session_closed', session_id: s.id, status: s.status, message: 'This session is closing or awaiting settlement; no more paid calls. Call close_session to finish settlement.' }, true);
    }

    const exp = s.authorization_expires_at ? Date.parse(s.authorization_expires_at) : NaN;
    if (!s.authorization_id || !Number.isFinite(exp) || exp <= this.o.now().getTime()) {
      return answer({ error: 'authorization_expired', session_id: s.id, message: 'The PayPal authorization behind this session is missing or expired; no paid call can run. Call close_session.' }, true);
    }
    const priceCents = cents(tool.price);
    if (priceCents == null || priceCents <= 0) return answer({ error: 'price_unavailable', tool: tool.name, message: 'This tool has no valid price; the call was not made.' }, true);
    let r: ReturnType<Ledger['reserve']>;
    try {
      r = this.o.ledger.reserve(s.id, tool.name, priceCents, this.iso(), (n) => requestHash(s.id, n, tool.name, args));
    } catch (e) {
      this.o.log(`session ${s.id}: reservation failed (${why(e)}); call refused`);
      return answer({ error: 'ledger_unavailable', message: 'The call could not be metered, so it was not made and nothing was charged.' }, true);
    }
    if (!r.ok) {
      if (r.reason === 'over_budget') {
        return answer(
          {
            error: 'budget_exceeded',
            message: `${tool.name} costs ${tool.price} ${s.currency} but only ${fromCents(r.remainingCents)} ${s.currency} of the approved ${fromCents(r.capCents)} remains. The call was not made and nothing was charged.`,
            tool: tool.name,
            price: tool.price,
            remaining: fromCents(r.remainingCents),
            cap: fromCents(r.capCents),
            currency: s.currency,
            session_id: s.id,
            top_up: 'Call close_session to settle this session, then call the tool again to get a new budget approved.',
          },
          true,
        );
      }
      return answer({ error: 'session_closed', session_id: s.id, status: r.status, message: 'The session is no longer active.' }, true);
    }

    const calls = this.o.ledger.calls(s.id);
    const thisCall = calls.find((c) => c.n === r.n)!;
    const inject = failFirstOf(s, this.o.failFirst);
    const failNow = inject.tools.includes(tool.name) && !calls.some((c) => c.tool === tool.name && c.n < r.n);
    try {
      if (failNow) throw new Error(inject.message);
      const result = await tool.run(args);
      const responseHash = sha256(canonicalJson(result));
      this.o.ledger.commit(s.id, r.n, responseHash, this.iso());
      return answer({
        result,
        metering: { session_id: s.id, call: r.n, tool: tool.name, price: tool.price, currency: s.currency, status: 'OK', request_hash: thisCall.request_hash, response_hash: responseHash, remaining: fromCents(r.remainingCents) },
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.o.ledger.release(s.id, r.n, error, this.iso());
      return answer(
        {
          error: 'upstream_failed',
          message: `${tool.name} failed: ${error}. This call is not charged.`,
          metering: { session_id: s.id, call: r.n, tool: tool.name, price: tool.price, currency: s.currency, status: 'FAILED', charged: false, request_hash: thisCall.request_hash, remaining: fromCents(r.remainingCents + priceCents) },
        },
        true,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Free tools

  async balance(mcpSession: string): Promise<ToolAnswer> {
    let s = this.o.ledger.openSessionFor(mcpSession);
    if (s?.status === 'pending_approval') s = await this.checkApproval(s);
    // The latest session ended with a declined funding source: say so instead of "no session".
    const declined = s?.status === 'cancelled' ? s : s ? null : this.o.ledger.latestSessionFor(mcpSession);
    if (declined?.status === 'cancelled' && declined.settlement_error) {
      return answer({
        ...this.balanceOf(declined),
        status: 'declined',
        message: 'PayPal declined this budget (see settlement_error); nothing was charged. The next paid call asks for a new approval.',
      });
    }
    if (!s) return answer({ status: 'none', budget_proposal: fromCents(this.budgetCents), currency: CURRENCY, message: 'No session yet: the first paid call asks for a budget.', price_list: priceList() });
    return answer(this.balanceOf(s));
  }

  private balanceOf(s: SessionRow) {
    const charged = this.o.ledger.chargedCents(s.id);
    const used = this.o.ledger.usedCents(s.id);
    return {
      session_id: s.id,
      status: s.status,
      currency: s.currency,
      cap: fromCents(s.cap_cents),
      charged: fromCents(charged),
      in_flight: fromCents(used - charged),
      remaining: fromCents(s.cap_cents - used),
      calls: this.o.ledger.calls(s.id).length,
      ...(s.status === 'pending_approval' ? { approval_url: s.approval_url, order_id: s.order_id } : {}),
      ...(s.settlement_error ? { settlement_error: s.settlement_error } : {}),
    };
  }

  priceList(): ToolAnswer {
    return answer(priceList());
  }

  /** The receipt of the caller's own current (or latest) session. */
  receiptFor(mcpSession: string): ToolAnswer {
    const s = this.o.ledger.latestSessionFor(mcpSession);
    if (!s) return answer({ error: 'no_session', message: 'This MCP session has no MeterMCP session yet.' }, true);
    return answer(this.receipt(s.id));
  }

  async closeFor(mcpSession: string): Promise<ToolAnswer> {
    const s = this.o.ledger.openSessionFor(mcpSession);
    if (!s) return answer({ error: 'no_session', message: 'There is no open session to close.' }, true);
    const r = await this.close(s.id);
    return answer(r, r.status === 'settlement_failed' || r.status === 'busy');
  }

  // -------------------------------------------------------------------------------------------
  // Settlement

  /**
   * Close a session and settle it: capture the sum of the OK calls with final_capture (remainder released), or
   * void the authorization when nothing was consumed. A failed capture/void leaves the session
   * `settlement_failed` (never "charged"); calling close again retries with the same PayPal-Request-Id, so a capture
   * PayPal already made is not made twice.
   */
  close(id: string): Promise<CloseResult> {
    const inFlight = this.closing.get(id);
    if (inFlight) return inFlight;
    const p = this.settle(id).finally(() => this.closing.delete(id));
    this.closing.set(id, p);
    return p;
  }

  private async settle(id: string): Promise<CloseResult> {
    // An approval in flight (the buyer just came back) may be authorizing in PayPal: wait for it, then read the
    // session again, so the authorization it creates is settled here instead of left on a cancelled session.
    await this.approving.get(id)?.catch(() => {});
    const s0 = this.o.ledger.session(id);
    if (!s0) return { status: 'not_found', session_id: id };
    if (s0.status === 'pending_approval') {
      // Never approved: nothing is held in PayPal (an unapproved order just expires).
      this.o.ledger.cancel(id, this.iso());
      return { status: 'cancelled', session_id: id, message: 'The budget was never approved; nothing to settle.' };
    }
    if (s0.status === 'settled' || s0.status === 'voided' || s0.status === 'cancelled' || s0.status === 'capture_declined') return this.closeResult(s0);
    // A close retry on a pending capture reconciles it (reads the capture) instead of capturing again.
    if (s0.status === 'capture_pending') return this.closeResult((await this.reconcile(id)) ?? s0);
    const begin = this.o.ledger.beginClose(id, this.iso());
    if (!begin.ok) {
      if (begin.reason === 'in_flight') return { status: 'busy', session_id: id, message: 'A paid call is still running; close again when it finishes.' };
      return { status: begin.status ?? 'not_found', session_id: id };
    }
    const s = this.o.ledger.session(id)!;
    const paypal = this.o.paypal;
    const charged = this.o.ledger.chargedCents(id);
    if (!paypal || !s.authorization_id) {
      this.o.ledger.settlementFailed(id, paypal ? 'No authorization recorded' : 'PayPal is not configured');
      return this.closeResult(this.o.ledger.session(id)!);
    }
    if (!Number.isSafeInteger(charged) || charged < 0 || charged > s.cap_cents) {
      this.o.ledger.settlementFailed(id, `Charged total ${charged} cents is not within the cap; not captured`);
      return this.closeResult(this.o.ledger.session(id)!);
    }
    try {
      // Verify the authorization in PayPal before moving money. CREATED: capture or void. CAPTURED on a retry: only
      // the idempotent replay of our own capture (same PayPal-Request-Id) can succeed. Anything else: fail closed.
      const auth = await paypal.payments.getAuthorization(s.authorization_id);
      // VOIDED with nothing consumed: the void already happened (ours, whose answer was lost, or the merchant's). Nothing
      // was charged and the hold is released: record it instead of failing every retry.
      if (auth.status === 'VOIDED' && charged === 0) {
        this.o.ledger.voided(id, { authorizationStatus: 'VOIDED', now: this.iso() });
        this.o.log(`session ${id}: nothing consumed, authorization ${s.authorization_id} already VOIDED at PayPal`);
        return this.closeResult(this.o.ledger.session(id)!);
      }
      const retryReplay = auth.status === 'CAPTURED' && charged > 0 && s.settlement_attempts > 1;
      if (auth.status !== 'CREATED' && !retryReplay) throw new Error(`Authorization ${s.authorization_id} is ${auth.status ?? 'without status'} in PayPal; not settled`);
      if (auth.amount?.currency_code !== s.currency || (cents(auth.amount?.value) ?? -1) < charged) {
        throw new Error(`Authorization ${s.authorization_id} does not cover ${fromCents(charged)} ${s.currency}; not settled`);
      }
      if (charged === 0) {
        const v = await paypal.payments.voidAuthorization(s.authorization_id, { requestId: `${id}-void` });
        if (v.status !== 'VOIDED') throw new Error(`Void answered ${v.status ?? 'no status'}, not VOIDED`);
        this.o.ledger.voided(id, { authorizationStatus: v.status, now: this.iso() });
        this.o.log(`session ${id}: nothing consumed, authorization ${s.authorization_id} voided (${v.status})`);
      } else {
        const ok = this.o.ledger.calls(id).filter((c) => c.status === 'OK');
        const note = `MeterMCP session ${id}: ${ok.length} paid tool call${ok.length === 1 ? '' : 's'} (${ok.map((c) => `${c.tool} ${fromCents(c.price_cents)}`).join(', ')}); failed calls not charged; remainder released.`;
        const capture = await paypal.payments.captureAuthorization(
          s.authorization_id,
          { amount: { currency_code: s.currency, value: fromCents(charged) }, finalCapture: true, invoiceId: `${id}-settle`, noteToPayer: note.length > 255 ? `${note.slice(0, 252)}...` : note },
          { requestId: `${id}-settle` },
        );
        if (!capture.id) throw new Error('PayPal returned a capture without id');
        if (capture.status === 'DECLINED' || capture.status === 'FAILED') {
          // A refusal is final for this capture (a retry with the same PayPal-Request-Id would replay it): on record,
          // nothing charged, as when a PENDING capture is declined later.
          this.o.ledger.declinedAtClose(id, { captureId: capture.id, captureStatus: capture.status, capturedCents: charged, reason: capture.status_details?.reason ?? null, now: this.iso() });
          this.o.log(`session ${id}: capture ${capture.id} ${capture.status}${capture.status_details?.reason ? ` (${capture.status_details.reason})` : ''}; not charged`);
          return this.closeResult(this.o.ledger.session(id)!);
        }
        if (capture.status !== 'COMPLETED' && capture.status !== 'PENDING') throw new Error(`Capture ${capture.id} is ${capture.status ?? 'without status'}`);
        if (capture.amount && (capture.amount.currency_code !== s.currency || cents(capture.amount.value) !== charged)) {
          throw new Error(`Capture ${capture.id} is ${capture.amount.value} ${capture.amount.currency_code}, not ${fromCents(charged)} ${s.currency}`);
        }
        // Read the authorization back: after a final capture PayPal reports it CAPTURED (the rest released).
        let authStatus: string | null = null;
        try {
          authStatus = (await paypal.payments.getAuthorization(s.authorization_id)).status ?? null;
        } catch {
          authStatus = null;
        }
        this.o.ledger.settled(id, { captureId: capture.id, captureStatus: capture.status ?? null, capturedCents: charged, authorizationStatus: authStatus, now: this.iso() });
        this.o.log(
          capture.status === 'PENDING'
            ? `session ${id}: capture ${capture.id} for ${fromCents(charged)} ${s.currency} is PENDING at PayPal; not claimed as charged until it completes`
            : `session ${id}: captured ${fromCents(charged)} ${s.currency} (capture ${capture.id} ${capture.status ?? '?'}), authorization ${authStatus ?? 'not re-read'}`,
        );
      }
    } catch (e) {
      this.o.ledger.settlementFailed(id, why(e));
      this.o.log(`session ${id}: settlement FAILED (${why(e)}); close again to retry`);
    }
    return this.closeResult(this.o.ledger.session(id)!);
  }

  /**
   * Read a PENDING capture back from PayPal (GET /v2/payments/captures/{id}) and move the session on: COMPLETED →
   * settled (exactly once), DECLINED/FAILED → capture_declined (the attempt stays on record, nothing is charged), still
   * PENDING → unchanged. Idempotent and deduplicated per session; a PayPal error changes nothing.
   */
  reconcile(id: string): Promise<SessionRow | null> {
    const inFlight = this.reconciling.get(id);
    if (inFlight) return inFlight;
    const p = this.doReconcile(id).finally(() => this.reconciling.delete(id));
    this.reconciling.set(id, p);
    return p;
  }

  private async doReconcile(id: string): Promise<SessionRow | null> {
    const s = this.o.ledger.session(id);
    if (!s || s.status !== 'capture_pending' || !s.capture_id || !this.o.paypal) return s;
    let status: string | undefined;
    try {
      status = (await this.o.paypal.payments.getCapture(s.capture_id)).status;
    } catch (e) {
      this.o.log(`session ${id}: could not read capture ${s.capture_id} (${why(e)}); still pending`);
      return s;
    }
    if (status === 'COMPLETED') {
      if (this.o.ledger.captureCompleted(id, this.iso())) this.o.log(`session ${id}: capture ${s.capture_id} COMPLETED; charged ${fromCents(s.captured_cents ?? 0)} ${s.currency}, remainder released`);
    } else if (status === 'DECLINED' || status === 'FAILED') {
      if (this.o.ledger.captureDeclined(id, status, this.iso())) this.o.log(`session ${id}: capture ${s.capture_id} ${status}; not charged`);
    }
    return this.o.ledger.session(id);
  }

  /** Reconcile every pending capture (the scheduled sweep). */
  async reconcilePending(): Promise<string[]> {
    const pending = this.o.ledger.sessionsWithStatus('capture_pending');
    for (const s of pending) await this.reconcile(s.id);
    return pending.map((s) => s.id);
  }

  private closeResult(s: SessionRow): CloseResult {
    const charged = this.o.ledger.chargedCents(s.id);
    return {
      status: s.status,
      session_id: s.id,
      currency: s.currency,
      cap: fromCents(s.cap_cents),
      charged: fromCents(charged),
      ...(s.status === 'settled' ? { captured: fromCents(s.captured_cents ?? 0), released: fromCents(s.cap_cents - (s.captured_cents ?? 0)), capture_id: s.capture_id, capture_status: s.capture_status } : {}),
      ...(s.status === 'voided' ? { captured: '0.00', released: fromCents(s.cap_cents), authorization_status: s.authorization_status } : {}),
      ...(s.status === 'settlement_failed' ? { settlement_error: s.settlement_error, retry: 'Call close_session again (or POST /sessions/{id}/close) to retry.' } : {}),
      ...(s.status === 'capture_pending'
        ? { capture_id: s.capture_id, capture_status: s.capture_status, message: 'PayPal reports the capture PENDING: not a final charge yet and nothing released yet. MeterMCP re-reads it; close again to check now.' }
        : {}),
      ...(s.status === 'capture_declined' ? { capture_id: s.capture_id, capture_status: s.capture_status, captured: '0.00', settlement_error: s.settlement_error } : {}),
      // What an MCP client can use: the receipt routes under /sessions are admin-only (404 on the public host).
      receipt_tool: 'get_receipt',
      receipt: 'Call get_receipt (free, no arguments) on this MCP session for the receipt: mandate, every call with its request hash, totals and settlement.',
    };
  }

  /** Close every active session idle for longer than `idleMs`. */
  async sweepIdle(idleMs: number): Promise<string[]> {
    const before = new Date(this.o.now().getTime() - idleMs).toISOString();
    const idle = this.o.ledger.idleSince(before);
    for (const s of idle) {
      this.o.log(`session ${s.id}: idle since ${s.last_activity_at}, closing`);
      await this.close(s.id);
    }
    return idle.map((s) => s.id);
  }

  // -------------------------------------------------------------------------------------------
  // Receipts

  receipt(id: string): Receipt | null {
    const s = this.o.ledger.session(id);
    return s ? buildReceipt(s, this.o.ledger.calls(id), this.o.env) : null;
  }

  sessionsByCapture(captureId: string): SessionRow[] {
    return this.o.ledger.sessionsByCapture(captureId);
  }
}

export interface CloseResult {
  status: string;
  session_id: string;
  [k: string]: unknown;
}
