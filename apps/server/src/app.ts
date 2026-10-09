/**
 * The ResolveKit API as a plain `(Request) => Promise<Response>` handler, so tests call it directly with a fake
 * PayPal fetch. Credentials and tokens stay inside the PayPal client: no response or log line carries them.
 */
import { timingSafeEqual } from 'node:crypto';
import { PayPalError, type Dispute, type EvidenceFile, type PayPalClient, type PayPalEnv } from '@resolvekit/paypal';
import type { AgentReceiptSource } from '../../web/src/domain/types.ts';
import { buildAttachments, CASE_FILES, UnknownFileError } from './documents.ts';
import { MeterMcpError, receiptFileName, toMeteredSession, type MeterMcpSource } from './metermcp.ts';
import { toSnapshot } from './mapping.ts';
import { checkAgainstDispute, isProblem, parseSubmission } from './validate.ts';

export interface AppOptions {
  /** null when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. */
  paypal: PayPalClient | null;
  env: PayPalEnv;
  /** Web case id → real PayPal dispute id. Unbound cases are never sent to PayPal. */
  bindings: Readonly<Record<string, string>>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Request guard: the port the server listens on (Host must be 127.0.0.1:port or localhost:port). */
  port: number;
  /** Per-launch secret every request must carry in `X-ResolveKit-Token` (the Vite proxy injects it). */
  token: string;
  /** Browser origins allowed to call the API when an Origin header is present. */
  allowedOrigins: readonly string[];
  /** MeterMCP on this machine: the agent case's session receipt, found by the disputed capture. null = not used. */
  meterMcp?: MeterMcpSource | null;
}

export const TOKEN_HEADER = 'x-resolvekit-token';
export const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Refuse anything that is not the ResolveKit web app on this machine. Submitting evidence is irreversible on a real
 * PayPal dispute, so: Host must be this server (blocks DNS rebinding), a present Origin must be a local web origin,
 * every request carries the per-launch token (other sites cannot read it), and POST bodies must be
 * application/json (a text/plain "simple" cross-site POST is refused).
 */
export function guard(req: Request, opts: Pick<AppOptions, 'port' | 'token' | 'allowedOrigins'>): Response | null {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return json(403, { error: 'FORBIDDEN_HOST' });
  const origin = req.headers.get('origin');
  if (origin != null && !opts.allowedOrigins.includes(origin)) return json(403, { error: 'FORBIDDEN_ORIGIN' });
  const token = req.headers.get(TOKEN_HEADER);
  if (!opts.token || !token || !sameSecret(token, opts.token)) return json(401, { error: 'MISSING_OR_BAD_TOKEN' });
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) {
    return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json' });
  }
  return null;
}

export type Handler = (req: Request) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

/** PayPal's issue code (e.g. EVIDENCE_TYPE_IS_NOT_ALLOWED), if it gave one. */
function paypalIssue(e: PayPalError): string | undefined {
  const b = e.body as { name?: string; details?: Array<{ issue?: string }> } | null;
  return b?.details?.find((d) => d.issue)?.issue ?? b?.name ?? undefined;
}

/** A PayPal failure as an API answer. Never includes request headers, tokens or credentials. */
function fromPayPalError(e: unknown): Response {
  if (e instanceof PayPalError) {
    const status = e.status === 404 ? 404 : e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 ? 422 : 502;
    return json(status, { error: e.message, paypalIssue: paypalIssue(e), paypalStatus: e.status, debugId: e.debugId ?? undefined });
  }
  if (isTimeout(e)) return json(504, { error: 'PAYPAL_TIMEOUT' });
  return json(502, { error: 'PAYPAL_UNREACHABLE' });
}

export function createApp(opts: AppOptions): Handler {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const isAgentCase = (caseId: string) => CASE_FILES[caseId]?.kind === 'agent';

  /**
   * The MeterMCP session behind the dispute's disputed capture. `none` (with the reason) when there is no capture,
   * no MeterMCP, or no session for it; throws MeterMcpError when MeterMCP cannot be asked.
   */
  const agentReceipt = async (d: Dispute): Promise<AgentReceiptSource> => {
    const capture = d.disputed_transactions?.[0]?.seller_transaction_id;
    if (!capture) return { kind: 'none', reason: 'PayPal reports no disputed capture' };
    if (!opts.meterMcp) return { kind: 'none', reason: 'MeterMCP is not configured on this server' };
    const sessionId = await opts.meterMcp.findByCapture(capture);
    if (!sessionId) return { kind: 'none', reason: `MeterMCP has no session for capture ${capture}` };
    return { kind: 'metermcp', session: toMeteredSession(await opts.meterMcp.receipt(sessionId)) };
  };
  let health: Promise<{ paypal: PayPalEnv | 'unconfigured'; error?: string }> | null = null;

  const checkHealth = () => {
    // Lazy: the first /api/health asks PayPal for a token; a success is remembered, a failure is retried next time.
    health ??= (async () => {
      if (!opts.paypal) return { paypal: 'unconfigured' as const, error: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set' };
      try {
        await opts.paypal.verifyCredentials();
        return { paypal: opts.env };
      } catch (e) {
        health = null;
        const why = e instanceof PayPalError ? `PayPal OAuth failed (${e.status})` : isTimeout(e) ? 'PayPal OAuth timed out' : 'PayPal unreachable';
        return { paypal: 'unconfigured' as const, error: why };
      }
    })();
    return health;
  };

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/api/health' && req.method === 'GET') {
      const h = await checkHealth();
      return json(200, { ...h, bound: h.paypal === 'unconfigured' ? [] : Object.keys(opts.bindings) });
    }
    const m = /^\/api\/disputes\/([A-Za-z0-9-]{1,64})(\/evidence)?$/.exec(path);
    if (!m) return json(404, { error: 'NOT_FOUND' });
    const caseId = m[1]!;
    const disputeId = opts.bindings[caseId];
    if (!disputeId) return json(404, { error: 'NOT_BOUND', detail: `Case ${caseId} is not bound to a PayPal dispute` });
    const paypal = opts.paypal;
    if (!paypal) return json(503, { error: 'PAYPAL_UNCONFIGURED' });

    if (!m[2] && req.method === 'GET') {
      let d: Dispute;
      try {
        d = await paypal.disputes.get(disputeId);
      } catch (e) {
        return fromPayPalError(e);
      }
      const snap = toSnapshot(d, caseId, opts.env, now());
      if (!isAgentCase(caseId)) return json(200, snap);
      let receipt: AgentReceiptSource;
      try {
        receipt = await agentReceipt(d);
      } catch (e) {
        receipt = { kind: 'none', reason: e instanceof MeterMcpError ? e.message : 'MeterMCP could not be read' };
      }
      return json(200, { ...snap, agentReceipt: receipt });
    }

    if (m[2] && req.method === 'POST') {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: 'INVALID_JSON' });
      }
      const sub = parseSubmission(body);
      if (isProblem(sub)) return json(sub.status, { error: sub.error, detail: sub.detail });
      if (sub.disputeId && sub.disputeId !== caseId) return json(400, { error: 'INVALID_SUBMISSION', detail: 'disputeId does not match the URL' });

      const demoFiles = (): EvidenceFile[] | Response => {
        try {
          return buildAttachments(caseId, sub.files);
        } catch (e) {
          if (e instanceof UnknownFileError) return json(422, { error: 'UNKNOWN_FILE', detail: e.message });
          throw e;
        }
      };
      let files: EvidenceFile[] | Response | null = isAgentCase(caseId) ? null : demoFiles();
      if (files instanceof Response) return files;

      // Read first: the rules depend on what PayPal shows now, not on what the browser last saw.
      let dispute;
      try {
        dispute = await paypal.disputes.get(disputeId);
      } catch (e) {
        return fromPayPalError(e);
      }
      const problem = checkAgainstDispute(sub, dispute);
      if (problem) return json(problem.status, { error: problem.error, detail: problem.detail });

      // Agent case: when MeterMCP has the session of the disputed capture, the evidence is that session: digital
      // delivery (carrier OTHER) referenced by the session id, with the PDF of the real receipt. Without a session
      // the demo documents go, as for any bound case. If MeterMCP cannot be asked, nothing is sent.
      let sessionRef: string | null = null;
      if (files === null) {
        let found: AgentReceiptSource;
        try {
          found = await agentReceipt(dispute);
        } catch (e) {
          return json(502, { error: 'METERMCP_UNAVAILABLE', detail: e instanceof Error ? e.message : 'MeterMCP could not be read' });
        }
        if (found.kind === 'metermcp') {
          const sid = found.session.sessionId;
          if (sub.carrier !== 'OTHER' || sub.tracking !== sid) {
            return json(422, { error: 'TRACKING_MISMATCH', detail: `Digital delivery of session ${sid}: carrier OTHER and tracking ${sid}` });
          }
          const wrong = sub.files.find((f) => f.name !== receiptFileName(sid));
          if (wrong) return json(422, { error: 'UNKNOWN_FILE', detail: `File ${wrong.name} is not the receipt of session ${sid}` });
          try {
            files = sub.files.length ? [{ name: receiptFileName(sid), type: 'application/pdf', data: await opts.meterMcp!.receiptPdf(sid) }] : [];
          } catch (e) {
            return json(502, { error: 'METERMCP_UNAVAILABLE', detail: e instanceof Error ? e.message : 'MeterMCP could not be read' });
          }
          sessionRef = sid;
        } else {
          files = demoFiles();
          if (files instanceof Response) return files;
        }
      }

      const tracking = { carrier_name: sub.carrier, tracking_number: sub.tracking, ...(sub.carrier === 'OTHER' ? { carrier_name_other: 'Digital delivery' } : {}) };
      try {
        await paypal.disputes.provideEvidence(
          disputeId,
          { evidence_type: sub.evidenceType, evidence_info: { tracking_info: [tracking] }, notes: sub.notes },
          files,
          { requestId: sub.requestId },
        );
      } catch (e) {
        return fromPayPalError(e);
      }
      log(`provide-evidence sent · case ${caseId} → ${disputeId} · ${sub.evidenceType} · ${files.length} file(s)${sessionRef ? ` · MeterMCP receipt ${sessionRef}` : ''} · request ${sub.requestId}`);
      // Accepted by PayPal is not "recorded": the client reads the dispute back to find out what PayPal stored.
      return json(202, { sent: true });
    }
    return json(405, { error: 'METHOD_NOT_ALLOWED' });
  };

  return async (req) => {
    const t = Date.now();
    let res: Response;
    try {
      res = guard(req, opts) ?? (await route(req));
    } catch {
      res = json(500, { error: 'INTERNAL' });
    }
    log(`${req.method} ${new URL(req.url).pathname} → ${res.status} · ${Date.now() - t} ms`);
    return res;
  };
}
