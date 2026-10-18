/**
 * The ResolveKit API as a plain `(Request) => Promise<Response>` handler, so tests call it directly with a fake
 * PayPal fetch. Credentials and tokens stay inside the PayPal client: no response or log line carries them.
 *
 * Sending evidence (irreversible on a real dispute) goes through a server-side submission intent:
 *   POST /api/disputes/:case/intent {evidenceType, edits, resolutions} → the exact content, composed HERE from the
 *        server's own documents and analysis (supported sentences only; an edit only with the server's own re-check)
 *   POST /api/disputes/:case/intent/:id/approve {contentHash}        → the merchant approves that exact content
 *   POST /api/disputes/:case/evidence {intentId}                     → sends that approved intent and nothing else,
 *        after composing it again from a fresh PayPal read: any difference refuses the send.
 * Notes, files or tracking in a request body are never sent.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { PayPalError, type Dispute, type EvidenceFile, type PayPalClient, type PayPalEnv, type WebhookEvent } from '@resolvekit/paypal';
import { workspaceIdFor } from './accounts.ts';
import { caseAllowedActions, caseInput, caseView, documentsSignature, type PayPalSource } from '@resolvekit/cases';
import { toCitations, withAnalysis, type AnalysisInput, type CaseAnalysis } from '@resolvekit/analyst';
import type { AgentReceiptSource, DisputeSnapshot, SubmissionFile } from '../../web/src/domain/types.ts';
import { correctionsOf, type Recheck } from '../../web/src/domain/draft.ts';
import { composeSubmission, contentHash, isComposeProblem, parseIntentRequest, type IntentContent, type IntentRequest } from '../../web/src/domain/intent.ts';
import { hasSellerEvidence, sellerEvidence } from '../../web/src/domain/recorded.ts';
import { InputPins, type AnalystService, type LiveGate, type Reservation } from './analysis.ts';
import { toBinding, verifyBinding, type Binding, type BindingState } from './bindings.ts';
import { buildAttachments, CASE_FILES, UnknownFileError } from './documents.ts';
import { IntentStore, publicIntent, type StoredIntent } from './intents.ts';
import { MeterMcpError, receiptFileName, toMeteredSession, type MeterMcpSource } from './metermcp.ts';
import { toSnapshot } from './mapping.ts';
import { checkAgainstDispute } from './validate.ts';
import { REFUSED_EARLY, acceptsImageBody, createUploadRoutes } from './uploads/routes.ts';
import { uploadDocuments, uploadFileName } from './uploads/documents.ts';
import { UploadStore, type UploadRecord } from './uploads/store.ts';

/** Actions that cost money or quota, or cannot be undone: a hosted demo may refuse them (see {@link CostGate}). */
export type CostlyAction = 'evidence' | 'live-analysis' | 'recheck' | 'upload';

/** A refusal as status + JSON body. */
export interface Refusal {
  status: number;
  body: { error: string; detail: string; [k: string]: unknown };
}

/** Who is acting on a request, or why they may not. */
export type Actor =
  | {
      ok: true;
      actor: string;
      /** The client (hosted: IP behind the trusted proxy). */
      client?: string;
      /** Hosted: the merchant workspace the person acts for (its members share the audit trail). */
      team?: string;
    }
  | { ok: false; refusal: Refusal };

/** Who is acting on a request: the signed-in person (hosted) or the local operator. */
export interface ActingPerson {
  id: string;
  name: string;
  label: string;
  workspaceId: string;
  role: 'owner' | 'member';
  reviewer: boolean;
}

/**
 * Asked right before a costly action, with the request that asks for it. `reserve` refuses (demo code missing,
 * daily cap reached) or reserves one unit atomically (check and count in one synchronous step, so concurrent requests
 * cannot overshoot a cap); the caller releases it when the action did not happen. Local mode has no gate.
 */
export interface CostGate {
  /** Hosted: the signed-in person acting (role and reviewer flag included); null when nobody is signed in. */
  person?(req: Request): ActingPerson | null;
  reserve(req: Request, action: CostlyAction): Reservation;
  /**
   * Who approves or sends: the hosted demo session (its unlock cookie, never the code itself). `unlocked`: real
   * PayPal is involved, so a demo session is required. Local mode has no gate: the local operator.
   */
  actor(req: Request, unlocked: boolean): Actor;
  /**
   * Hosted: whether this request may see and act on the real PayPal disputes, i.e. it comes from the seller's own
   * workspace. Everyone else gets the same cases on the simulator. Absent (local mode): yes.
   */
  live?(req: Request): Promise<boolean>;
  /** Hosted: the PayPal merchant id the person acts for; a send is refused unless it is the dispute's seller. */
  merchant?(req: Request): string | null;
}

export type { Reservation };

/** What the API routes need, in local and hosted mode alike. */
export interface ApiOptions {
  /** null when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set. */
  paypal: PayPalClient | null;
  env: PayPalEnv;
  /**
   * Web case id → the real PayPal payment it stands for: { dispute, capture } (or the old dispute-id string, which
   * cannot pass the send-time check, see bindings.ts). Unbound cases are never sent to PayPal. May change in place.
   */
  bindings: Readonly<Record<string, string | Binding>>;
  /**
   * Fresh disputes in reserve behind each case's active binding (a list in BINDINGS_JSON, see bindings.ts). PayPal
   * takes a seller's evidence once per dispute: when the active one is used, the case moves to the next (in place).
   */
  reserve?: Record<string, Binding[]> | null;
  /** How long a dispute whose seller evidence just went in stays active, so whoever sent it sees PayPal's read-back (15 min). */
  rotateAfterMs?: number;
  /** A case moved to the next dispute of its reserve (hosted mode analyses it again). */
  onRebound?: (caseId: string) => void;
  now?: () => Date;
  log?: (line: string) => void;
  /** MeterMCP: the agent case's session receipt, found by the disputed capture. null = not used. */
  meterMcp?: MeterMcpSource | null;
  /** The AI analyst (packages/analyst). null/absent: the analysis routes answer 503. */
  analyst?: AnalystService | null;
  /** Hosted mode: refuses costly actions without the demo code or over the daily caps. Absent: always allowed. */
  gate?: CostGate | null;
  /** The input each case was analysed with before the seller's evidence went in (see InputPins). Default: in memory. */
  pins?: InputPins | null;
  /** How long a PayPal read of a bound case is reused to build the analyst's input (default 60 s). */
  readTtlMs?: number;
  /** Waits before each read of a dispute a webhook named (default 0, 2 s, 10 s: three tries). */
  webhookReadWaitsMs?: number[];
  /** Submission intents and the audit log (persisted on the data dir by main.ts). Default: in memory. */
  intents?: IntentStore | null;
  /** Merchant evidence uploads (on the data dir by main.ts). Default: in memory. */
  uploads?: UploadStore | null;
  /** Total size of stored upload files (default MAX_STORAGE_BYTES, uploads/limits.ts). */
  uploadStorageBytes?: number;
  /** Size of one stored (sanitised) upload file (default MAX_STORED_BYTES, uploads/limits.ts). */
  uploadStoredFileBytes?: number;
}

/** Local mode: the API behind the local guard (Host, Origin, per-launch token, JSON-only POST). */
export interface AppOptions extends ApiOptions {
  /** Request guard: the port the server listens on (Host must be 127.0.0.1:port or localhost:port). */
  port: number;
  /** Per-launch secret every request must carry in `X-ResolveKit-Token` (the Vite proxy injects it). */
  token: string;
  /** Browser origins allowed to call the API when an Origin header is present. */
  allowedOrigins: readonly string[];
}

export const TOKEN_HEADER = 'x-resolvekit-token';
export const LOCAL_OPERATOR = 'local operator';
/** Local mode has no accounts: the operator at this machine acts as an owner. */
const LOCAL_PERSON: ActingPerson = { id: 'local', name: LOCAL_OPERATOR, label: LOCAL_OPERATOR, workspaceId: 'local', role: 'owner', reviewer: false };

/** Control characters (line breaks excepted where allowed) and bidi overrides: never in text a client sends us. */
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
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
 * application/json (a text/plain "simple" cross-site POST is refused); only the evidence upload route also takes
 * image/png and image/jpeg (not "simple" types either).
 */
export function guard(req: Request, opts: Pick<AppOptions, 'port' | 'token' | 'allowedOrigins'>): Response | null {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return json(403, { error: 'FORBIDDEN_HOST' });
  const origin = req.headers.get('origin');
  if (origin != null && !opts.allowedOrigins.includes(origin)) return json(403, { error: 'FORBIDDEN_ORIGIN' });
  const token = req.headers.get(TOKEN_HEADER);
  if (!opts.token || !token || !sameSecret(token, opts.token)) return json(401, { error: 'MISSING_OR_BAD_TOKEN' });
  const type = req.headers.get('content-type');
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(type ?? '') && !acceptsImageBody(req.method, new URL(req.url).pathname, type)) {
    return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json (an evidence upload may be image/png or image/jpeg)' });
  }
  return null;
}

export type Handler = (req: Request) => Promise<Response>;

export const json = (status: number, body: unknown) =>
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

/** A short reason for the audit log (codes, and PayPal's debug_id to trace the request with PayPal). */
function failureText(e: unknown): string {
  if (e instanceof PayPalError) return `PayPal ${e.status}${paypalIssue(e) ? ` ${paypalIssue(e)}` : ''}${e.debugId ? ` · debug_id ${e.debugId}` : ''}`;
  return isTimeout(e) ? 'PayPal timed out' : 'PayPal unreachable';
}

/** Local mode: every request passes {@link guard} first. */
export function createApp(opts: AppOptions): Handler {
  const api = createApi(opts);
  // The uploads' refund signal is for hosted mode's per-address limit only.
  const local: Handler = async (req) => {
    const res = await api(req);
    // Only the upload routes' own (mutable) responses carry it; any other response is left untouched.
    if (res.headers.has(REFUSED_EARLY)) res.headers.delete(REFUSED_EARLY);
    return res;
  };
  return withLog(opts.log, local, (req) => guard(req, opts));
}

/** Runs `pre` (a guard) and then `api`; a throw becomes 500; one log line per request (method, path, status, time). */
export function withLog(log: ((line: string) => void) | undefined, api: Handler, pre?: (req: Request) => Response | null): Handler {
  const write = log ?? (() => {});
  return async (req) => {
    const t = Date.now();
    let res: Response;
    try {
      res = pre?.(req) ?? (await api(req));
    } catch {
      res = json(500, { error: 'INTERNAL' });
    }
    // The PayPal sign-in return key is single-use and bound to one browser; it still stays out of the logs. So does the
    // webhook URL's secret key.
    const path = new URL(req.url).pathname.replace(/^(\/api\/auth\/paypal\/return\/|\/api\/paypal\/webhook\/)[^/]+$/, '$1…');
    write(`${req.method} ${path} → ${res.status} · ${Date.now() - t} ms`);
    return res;
  };
}

/** The /api routes without any request guard: the caller puts one in front (local {@link guard} or hosted mode). */
/** The API handler, plus the analyst's input as the server builds it (hosted warm-up, tests). */
export type Api = Handler & {
  inputFor: (caseId: string) => Promise<AnalysisInput | Response>;
  /** The PayPal merchant ids that are the seller on a bound dispute (hosted: whose workspace sees real PayPal). */
  sellerIds: () => Promise<Set<string>>;
  /** The seller's business name on the bound disputes, by merchant id (known after sellerIds). */
  sellerName: (merchantId: string) => string | null;
  /** Forget the PayPal reads kept for building inputs and invalidate open intents (the bindings changed). */
  forgetReads: () => void;
  /** A verified PayPal webhook event (webhook.ts): the dispute is read again from PayPal; nothing in it is trusted. */
  paypalNotified: (e: WebhookEvent) => Promise<void>;
  /** The intents and audit log (tests, main.ts). */
  intents: IntentStore;
  /** For the operator's check (hosted /api/ops/status): PayPal's state and each binding verified on a fresh read now. */
  opsReport: () => Promise<OpsReport>;
  /** The person acting on a request (see {@link ActingPerson}); null when signed out. */
  personOf: (req: Request) => ActingPerson | null;
};

/** What the operator's check sees: PayPal connected, and each bound case's binding as a fresh read verified it. */
export interface OpsReport {
  paypal: PayPalEnv | 'unconfigured';
  error?: string;
  bindings: Record<
    string,
    {
      dispute: string;
      capture: string | null;
      status: BindingState | 'unchecked';
      reasons: string[];
      checkedAt: string | null;
      /** PayPal already has the seller's evidence on it, or closed it: no judge can send to it any more. */
      used: boolean;
      /** Fresh disputes left behind it. */
      reserve: number;
    }
  >;
}

/** sha256 hex of a string. */
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** The case as the server sees it right now: where PayPal's data comes from, and the analyst's input. */
interface CaseState {
  source: PayPalSource;
  input: AnalysisInput;
  /** The bound dispute as just read (bound cases only). */
  dispute: Dispute | null;
  snap: DisputeSnapshot | null;
  /** The bound PayPal dispute id, or null when the case runs on the simulator. */
  disputeId: string | null;
  /** The confirmed uploads in the input (this workspace's, of the case's active dispute): the only ones attachable. */
  uploads: UploadRecord[];
}

/** An intent composed from a case state: its content and hash, and what is needed to compose it again. */
interface ComposedIntent {
  /** The exact analysis the sentences came from, and its hash (pinned with the intent). */
  analysis: CaseAnalysis;
  analysisHash: string;
  content: IntentContent;
  contentHash: string;
  rechecks: Record<string, Recheck>;
  /** The exact bytes of `content.files`, in order: what a send gives PayPal (their SHA-256 is in the content). */
  attachments: EvidenceFile[];
}

export function createApi(opts: ApiOptions): Api {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const isAgentCase = (caseId: string) => CASE_FILES[caseId]?.kind === 'agent';
  const intents = opts.intents ?? new IntentStore({ now });
  /** The verifier's verdicts on edited sentences, by `${analysisKey}\n${text}`: only these edits can be sent. */
  const verified = new Map<string, Recheck>();
  /** Bounded: the oldest verdicts go first (an intent keeps the verdicts it was composed with). */
  const MAX_VERIFIED = 2000;
  const rememberVerdict = (k: string, r: Recheck) => {
    verified.delete(k);
    verified.set(k, r);
    if (verified.size > MAX_VERIFIED) verified.delete(verified.keys().next().value!);
  };

  /** Forget the analyses with these keys and everything that hangs from them (job, progress, stored file, re-check verdicts). */
  const forgetAnalyses = (keys: string[]) => {
    opts.analyst?.forget(keys);
    for (const k of [...verified.keys()]) if (keys.some((key) => k.startsWith(`${key}
`))) verified.delete(k);
  };
  const staleUpload = () => json(409, { error: 'UPLOAD_CHANGED', detail: 'An upload this analysis read was deleted while it was being made; the analysis was dropped. Try again.' });

  /** The case's binding, normalised (string or object form), or null. */
  const bindingOf = (caseId: string): Binding | null => toBinding(opts.bindings[caseId]);
  /**
   * The last verification of each binding, from a fresh read (see bindings.ts). Kept with the binding it verified:
   * a changed binding is "unchecked" until read again. Shown by /api/health; sending re-verifies anyway.
   */
  const bindingStatus = new Map<string, { status: BindingState; reasons: string[]; checkedAt: string; binding: Binding }>();
  const bindingState = (caseId: string) => {
    const b = bindingOf(caseId);
    const st = bindingStatus.get(caseId);
    if (!b) return null;
    if (!st || st.binding.dispute !== b.dispute || st.binding.capture !== b.capture) return { status: 'unchecked' as const, reasons: [], checkedAt: null };
    return { status: st.status, reasons: st.reasons, checkedAt: st.checkedAt };
  };

  /** Who is acting (hosted: the signed-in person; local: the operator at this machine). */
  const actorOf = (req: Request, unlocked: boolean): Actor => (opts.gate ? opts.gate.actor(req, unlocked) : { ok: true, actor: LOCAL_OPERATOR });
  /** The person acting (hosted: from the session, null when signed out; local: the operator, an owner). */
  const personOf = (req: Request): ActingPerson | null => (opts.gate ? (opts.gate.person?.(req) ?? null) : LOCAL_PERSON);
  /** Whether this request sees the real PayPal disputes (hosted: the seller's workspace only; local: always). */
  const viewerLive = async (req?: Request): Promise<boolean> => !req || !opts.gate?.live || (await opts.gate.live(req));

  /** The seller's PayPal merchant id on each bound dispute, from the last read of it. */
  const sellers = new Map<string, { dispute: string; merchant: string | null; name: string | null }>();
  const noteSeller = (caseId: string, d: Dispute) => {
    const s = d.disputed_transactions?.[0]?.seller;
    sellers.set(caseId, { dispute: d.dispute_id ?? '', merchant: s?.merchant_id ?? null, name: s?.name ?? null });
  };
  /** The seller's name as PayPal gives it on a bound dispute (after {@link sellerIds} read them), or null. */
  const sellerName = (merchantId: string): string | null => [...sellers.values()].find((s) => s.merchant === merchantId && s.name)?.name ?? null;
  /** The merchant ids that are the seller on a bound dispute (each dispute read once, then on every fresh read). */
  const sellerIds = async (): Promise<Set<string>> => {
    const paypal = opts.paypal;
    if (paypal) {
      await Promise.all(
        Object.keys(opts.bindings).map(async (caseId) => {
          const b = bindingOf(caseId);
          if (!b || sellers.get(caseId)?.dispute === b.dispute) return;
          try {
            noteSeller(caseId, await paypal.disputes.get(b.dispute));
          } catch {
            /* unreadable now: asked again next time */
          }
        }),
      );
    }
    const out = new Set<string>();
    for (const [caseId, s] of sellers) if (s.merchant && bindingOf(caseId)?.dispute === s.dispute) out.add(s.merchant);
    return out;
  };

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
  /** For the analyst: asked right before it would call the model (nothing stored for these documents, or a refresh). */
  const liveGate = (req: Request, action: CostlyAction): LiveGate | undefined => {
    const { gate } = opts;
    return gate ? () => gate.reserve(req, action) : undefined;
  };

  /** The dispute as just read, as the web app's snapshot (with the agent case's MeterMCP session). */
  const snapshotOf = async (caseId: string, d: Dispute): Promise<DisputeSnapshot> => {
    let snap = toSnapshot(d, caseId, opts.env, now());
    if (isAgentCase(caseId)) {
      let receipt: AgentReceiptSource;
      try {
        receipt = await agentReceipt(d);
      } catch (e) {
        receipt = { kind: 'none', reason: e instanceof MeterMcpError ? e.message : 'MeterMCP could not be read' };
      }
      snap = { ...snap, agentReceipt: receipt };
    }
    return snap;
  };

  /**
   * A fresh read of a bound case from PayPal, with the agent case's MeterMCP session: what GET /api/disputes answers,
   * and what the analyst's input is built from. Throws what PayPal throws.
   */
  // Keyed by case, and holding the dispute it read: a read that finishes after the case moved to another dispute of its
  // reserve is never taken for the new one.
  const reads = new Map<string, { at: number; dispute: string; snap: DisputeSnapshot }>();
  const readCase = async (caseId: string, disputeId: string, paypal: PayPalClient): Promise<DisputeSnapshot> => {
    const d = await paypal.disputes.get(disputeId);
    noteSeller(caseId, d);
    const snap = await snapshotOf(caseId, d);
    reads.set(caseId, { at: now().getTime(), dispute: disputeId, snap });
    // A judge who only opens the case moves it on too: this answer is the used dispute's, the next view the fresh one's.
    const b = bindingOf(caseId);
    if (b && b.dispute === disputeId) rotateIfUsed(caseId, b, snap);
    return snap;
  };

  /**
   * The analyst's input, built entirely here: the server's own demo case (packages/cases), its own PayPal read and its
   * own MeterMCP read, assembled exactly as the web app shows them. Nothing a client sends reaches it. A bound case
   * whose dispute cannot be read has no input (the web app waits for PayPal's data too), unless PayPal is not
   * connected at all, in which case the web app runs the case on the simulator and so does this.
   */
  const pins = opts.pins ?? new InputPins();
  /**
   * Analysis keys of inputs built WITHOUT a real PayPal read (the simulator): the only analyses /progress answers to a
   * request that does not see the real dispute. Fail closed: a key this server has not built for the simulator since
   * it started (a live input's, or any key after a restart) is not answered to them; the web app asks for the analysis
   * (which records the key) before it polls.
   */
  const simulatedKeys = new Set<string>();
  const markSimulated = async (input: AnalysisInput) => {
    if (!opts.analyst) return;
    simulatedKeys.add(await opts.analyst.key(input));
    if (simulatedKeys.size > 5000) simulatedKeys.delete(simulatedKeys.values().next().value!);
  };
  const uploads = opts.uploads ?? new UploadStore({ dir: null, now });
  /**
   * The confirmed uploads the requesting person's workspace made for this case and dispute: none without a request
   * (warm-up, the operator's checks) or without a signed-in person of the seller's workspace. Pending, archived and
   * other workspaces' uploads never join an input.
   */
  const confirmedUploads = async (caseId: string, disputeId: string | null, req?: Request): Promise<UploadRecord[]> => {
    const person = req ? personOf(req) : null;
    if (!person || !(await viewerLive(req))) return [];
    return uploads.list({ workspaceId: person.workspaceId, caseId, boundDisputeId: disputeId, statuses: ['confirmed'] });
  };
  /** Whether each of these upload records is still confirmed and unchanged in the store (synchronous). */
  const uploadsUnchanged = (recs: readonly UploadRecord[]): boolean =>
    recs.every((r) => {
      const cur = uploads.get(r.id);
      return !!cur && cur.status === 'confirmed' && cur.sha256 === r.sha256 && cur.evidenceId === r.evidenceId && JSON.stringify(cur.lines) === JSON.stringify(r.lines);
    });
  /**
   * The input with the uploads' documents after the case's own. The pin (InputPins, keyed by case only) is resolved
   * on the input without them, so it never holds one workspace's uploads (nor their text) for another's request.
   */
  const withUploads = (input: AnalysisInput, recs: UploadRecord[]): AnalysisInput => {
    const docs = uploadDocuments(recs);
    return docs.length ? { ...input, documents: [...input.documents, ...docs] } : input;
  };
  /** The analyst's input and the ids of the uploads in it. */
  const serverInputWith = async (caseId: string, req?: Request): Promise<{ input: AnalysisInput; uploadIds: string[] } | Response> => {
    const demo = CASE_FILES[caseId]!;
    const disputeId = bindingOf(caseId)?.dispute;
    let source: PayPalSource = { kind: 'simulated' };
    if (disputeId && opts.paypal && (await viewerLive(req))) {
      const cached = reads.get(caseId);
      try {
        const fresh = cached && cached.dispute === disputeId && now().getTime() - cached.at < (opts.readTtlMs ?? 60_000);
        source = { kind: 'live', snap: fresh ? cached.snap : await readCase(caseId, disputeId, opts.paypal), failed: null };
      } catch (e) {
        if ((await checkHealth()).paypal !== 'unconfigured') return fromPayPalError(e);
      }
    }
    const submitted = source.kind === 'live' && hasSellerEvidence(source.snap);
    const recs = await confirmedUploads(caseId, disputeId ?? null, req);
    const input = withUploads(pins.resolve(caseId, caseInput(demo, source), submitted), recs);
    // An input with uploads is the seller workspace's: /progress never answers it to anyone else.
    if (source.kind === 'simulated' && recs.length === 0) await markSimulated(input);
    return { input, uploadIds: recs.map((r) => r.id) };
  };
  const serverInput = async (caseId: string, req?: Request): Promise<AnalysisInput | Response> => {
    const r = await serverInputWith(caseId, req);
    return r instanceof Response ? r : r.input;
  };

  /** Whether a case goes to real PayPal: bound, and PayPal connected (the web app decides the same way, from /health). */
  const boundDispute = async (caseId: string, req?: Request): Promise<string | null> => {
    const disputeId = bindingOf(caseId)?.dispute;
    if (!disputeId || !opts.paypal || !(await viewerLive(req))) return null;
    return (await checkHealth()).paypal === 'unconfigured' ? null : disputeId;
  };

  /**
   * The case right now, for composing or re-checking an intent: a bound case is read fresh from PayPal (never from
   * the read cache) and its binding verified on that read (bindings.ts): an unreadable dispute or a binding that is
   * not this payment fails closed (409, with the reasons). A simulated case is the demo case.
   */
  const caseState = async (caseId: string, req?: Request): Promise<CaseState | Response> => {
    const demo = CASE_FILES[caseId]!;
    const disputeId = await boundDispute(caseId, req);
    if (!disputeId) {
      const source: PayPalSource = { kind: 'simulated' };
      const recs = await confirmedUploads(caseId, bindingOf(caseId)?.dispute ?? null, req);
      return { source, input: withUploads(pins.resolve(caseId, caseInput(demo, source), false), recs), dispute: null, snap: null, disputeId: null, uploads: recs };
    }
    const binding = bindingOf(caseId)!;
    const mark = (status: BindingState, reasons: string[]) => bindingStatus.set(caseId, { status, reasons, checkedAt: now().toISOString(), binding });
    let dispute: Dispute;
    try {
      dispute = await opts.paypal!.disputes.get(disputeId);
    } catch (e) {
      const why = `PayPal could not be read for dispute ${disputeId} (${failureText(e)})`;
      mark('unavailable', [why]);
      return json(409, { error: 'BINDING_UNAVAILABLE', detail: `Sending is blocked: ${why}`, reasons: [why] });
    }
    noteSeller(caseId, dispute);
    const check = verifyBinding({ value: demo.summary.amount, currency: demo.summary.currency, transactionId: demo.summary.transactionId }, binding, dispute);
    mark(check.status, check.reasons);
    if (check.status !== 'verified') {
      log(`binding ${caseId} → ${disputeId}: INVALID at send time · ${check.reasons.join('; ')}`);
      return json(409, { error: 'BINDING_INVALID', detail: 'Sending is blocked: the bound PayPal dispute is not this case’s payment', reasons: check.reasons });
    }
    const snap = await snapshotOf(caseId, dispute);
    reads.set(caseId, { at: now().getTime(), dispute: disputeId, snap });
    const source: PayPalSource = { kind: 'live', snap, failed: null };
    const recs = await confirmedUploads(caseId, disputeId, req);
    const state = { source, input: withUploads(pins.resolve(caseId, caseInput(demo, source), hasSellerEvidence(snap)), recs), dispute, snap, disputeId, uploads: recs };
    // This request goes on with what it read; the next one reads the next dispute of the reserve, if this one is used.
    rotateIfUsed(caseId, binding, snap);
    return state;
  };

  // ---------------------------------------------------------------------------------------------- reserve
  const ROTATE_AFTER_MS = opts.rotateAfterMs ?? 15 * 60_000;
  /** Whether the active dispute of each case was used when last read (the operator's check reports it). */
  const usedNow = new Map<string, boolean>();
  /** When this server first saw each dispute used: the grace's start when PayPal gives the evidence no usable date. */
  const firstSeenUsed = new Map<string, number>();
  /**
   * Since when a dispute is used for the demo: closed (at once), or the seller's evidence, by PayPal's date (a date in
   * the future counts as when this server first saw it used, as does one with no usable date); null: unused.
   */
  const usedSince = (disputeId: string, snap: DisputeSnapshot): number | null => {
    if (snap.status === 'RESOLVED') return 0;
    const ev = sellerEvidence(snap);
    if (ev.length === 0) return null;
    const t = now().getTime();
    const seen = firstSeenUsed.get(disputeId) ?? t;
    if (firstSeenUsed.size > 1000) firstSeenUsed.clear();
    firstSeenUsed.set(disputeId, seen);
    const dates = ev.map((e) => Date.parse(e.date ?? e.storedAt)).filter(Number.isFinite);
    return dates.length ? Math.min(Math.max(...dates), seen) : seen;
  };
  const rotateIfUsed = (caseId: string, binding: Binding, snap: DisputeSnapshot) => {
    // Another read of this case may have moved it on while this one waited for PayPal: one step per used dispute.
    if (bindingOf(caseId)?.dispute !== binding.dispute) return;
    const since = usedSince(binding.dispute, snap);
    usedNow.set(caseId, since != null);
    const queue = opts.reserve?.[caseId];
    if (since == null || !queue?.length || now().getTime() - since < ROTATE_AFTER_MS) return;
    const next = queue.shift()!;
    (opts.bindings as Record<string, string | Binding>)[caseId] = next;
    reads.delete(caseId);
    sellers.delete(caseId);
    bindingStatus.delete(caseId);
    usedNow.delete(caseId);
    log(`reserve · case ${caseId}: ${binding.dispute} is used (${snap.status === 'RESOLVED' ? 'resolved' : 'seller evidence recorded'}) → ${next.dispute} · ${queue.length} left in reserve`);
    // The old dispute's uploads keep their records only (files and text dropped). Never breaks this request; counts only.
    const moved = uploads.archiveCase(caseId, binding.dispute);
    if (moved.archived || moved.failed) log(`reserve · case ${caseId}: ${moved.archived} upload(s) archived${moved.failed ? `, ${moved.failed} could not be archived (still bound to the old dispute: in no input)` : ''}`);
    opts.onRebound?.(caseId);
  };

  /**
   * Compose the intent's content from the server's own case state and analysis. `rechecks`: verdicts already bound to
   * an intent (when composing it again before sending); otherwise the verdicts this server recorded for the edits.
   */
  const compose = async (caseId: string, st: CaseState, req: IntentRequest, rechecks?: Record<string, Recheck>, pinned?: CaseAnalysis | null): Promise<ComposedIntent | Response> => {
    // The agent case's evidence is the MeterMCP receipt: only a COMPLETED capture is proof of a final charge.
    const receipt = st.snap?.agentReceipt;
    if (receipt?.kind === 'metermcp' && receipt.session.settlement.status !== 'captured') {
      const s = receipt.session.settlement;
      return json(409, {
        error: 'RECEIPT_NOT_FINAL',
        detail: `The MeterMCP session is ${s.status}${s.captureStatus ? ` (PayPal capture ${s.captureStatus})` : ''}: its receipt is not proof of a final charge yet, so it is not sent`,
        reasons: [`MeterMCP settlement ${s.status}`],
      });
    }
    // Only confirmed uploads of this workspace, case and active dispute (those in the input) can be attached.
    for (const id of req.attachments ?? []) {
      if (!st.uploads.some((r) => r.id === id)) return json(422, { error: 'UNKNOWN_UPLOAD', detail: `Upload ${id} is not a confirmed upload of this case’s current dispute` });
    }
    const analyst = opts.analyst;
    if (!analyst) return json(503, { error: 'ANALYST_UNAVAILABLE', detail: 'The analyst is not set up on this server' });
    // Composing again before a send uses the very analysis the intent was composed from (if it is still an analysis of
    // these documents): someone else's re-run of the analysis does not change an approved response.
    const key = await analyst.key(st.input);
    const a = pinned && pinned.key === key ? { key, analysis: pinned } : await analyst.stored(st.input);
    if (!a) return json(409, { error: 'NO_ANALYSIS', detail: 'There is no analysis of these documents on the server; analyse the case first' });
    const demo = CASE_FILES[caseId]!;
    const c = withAnalysis(caseView(demo, st.source), a.analysis, st.input);
    const used: Record<string, Recheck> = {};
    const composed = composeSubmission({
      c,
      req,
      verified: (text) => {
        const id = Object.keys(req.edits).find((k) => req.edits[k] === text);
        const r = rechecks ? (id ? rechecks[id] : undefined) : verified.get(`${a.key}\n${text}`);
        if (r && id) used[id] = r;
        return r ?? null;
      },
      allowedActions: caseAllowedActions(st.source, undefined, demo.allowedActions),
      submitted: !!st.snap && hasSellerEvidence(st.snap),
      // From the uploads in the input this server built: the same corrections the web app shows.
      corrections: correctionsOf(st.input.documents),
    });
    if (isComposeProblem(composed)) return json(composed.status, { error: composed.error, detail: composed.detail, ...(composed.blockers ? { blockers: composed.blockers } : {}) });
    const s = composed.submission;
    if (st.dispute) {
      const problem = checkAgainstDispute(s, st.dispute);
      if (problem) return json(problem.status, { error: problem.error, detail: problem.detail });
    }
    const built = await filesFor(caseId, st, s.files, req.attachments ?? []);
    if (built instanceof Response) return built;
    const content: IntentContent = {
      caseId,
      disputeId: st.disputeId,
      documentsHash: sha256(documentsSignature(st.input)),
      analysisKey: a.key,
      evidenceType: s.evidenceType,
      carrier: s.carrier,
      tracking: s.tracking,
      notes: s.notes,
      files: built.map((b) => b.file),
      sentences: composed.sentences,
      resolutionNotes: composed.resolutionNotes,
      ...(req.confirmedCorrections?.length ? { confirmedCorrections: [...req.confirmedCorrections] } : {}),
    };
    return {
      content,
      contentHash: await contentHash(content),
      rechecks: used,
      analysis: a.analysis,
      analysisHash: sha256(JSON.stringify(a.analysis)),
      attachments: built.map((b) => b.data),
    };
  };

  /**
   * The files of a composition, with the bytes PayPal would receive and their SHA-256: the case's own PDFs (or the
   * agent case's real MeterMCP receipt), then the selected confirmed uploads as stored (sanitised), in evidence order.
   * A stored upload whose bytes no longer match its confirmed SHA-256 is refused (409 UPLOAD_CHANGED).
   */
  const filesFor = async (caseId: string, st: CaseState, caseFiles: readonly SubmissionFile[], selected: readonly string[]): Promise<{ file: SubmissionFile; data: EvidenceFile }[] | Response> => {
    const out: { file: SubmissionFile; data: EvidenceFile }[] = [];
    const sid = isAgentCase(caseId) && st.snap?.agentReceipt?.kind === 'metermcp' ? st.snap.agentReceipt.session.sessionId : null;
    if (sid) {
      if (caseFiles.some((f) => f.name !== receiptFileName(sid))) return json(422, { error: 'UNKNOWN_FILE', detail: `Only the receipt of session ${sid} can be attached` });
      for (const f of caseFiles) {
        let data: Uint8Array;
        try {
          data = await opts.meterMcp!.receiptPdf(sid);
        } catch (e) {
          return json(502, { error: 'METERMCP_UNAVAILABLE', detail: e instanceof Error ? e.message : 'MeterMCP could not be read' });
        }
        out.push({ file: { name: f.name, size: f.size, sha256: sha256(data), source: 'receipt' }, data: { name: f.name, type: 'application/pdf', data } });
      }
    } else {
      try {
        const pdfs = buildAttachments(caseId, caseFiles);
        caseFiles.forEach((f, n) => {
          const { sha256: hash, ...data } = pdfs[n]!;
          out.push({ file: { name: f.name, size: f.size, sha256: hash, source: 'demo' }, data });
        });
      } catch (e) {
        if (e instanceof UnknownFileError) return json(422, { error: 'UNKNOWN_FILE', detail: e.message });
        throw e;
      }
    }
    const recs = st.uploads.filter((r) => selected.includes(r.id)).sort((a, b) => evidenceNumber(a.evidenceId) - evidenceNumber(b.evidenceId));
    for (const r of recs) {
      const bytes = uploads.sanitised(r.id);
      if (!bytes || !r.mime || !r.sha256 || sha256(bytes) !== r.sha256) {
        return json(409, { error: 'UPLOAD_CHANGED', detail: `The stored file of ${r.evidenceId} no longer matches the one confirmed; it is not attached` });
      }
      const name = uploadFileName(r);
      out.push({ file: { name, size: `${Math.max(1, Math.round(bytes.length / 1024))} KB`, sha256: r.sha256, source: 'upload' }, data: { name, type: r.mime, data: bytes } });
    }
    return out;
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

  const readJson = async (req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> => {
    try {
      return { ok: true, body: await req.json() };
    } catch {
      return { ok: false, res: json(400, { error: 'INVALID_JSON' }) };
    }
  };

  /**
   * POST /api/cases/:id/analysis {input} (?refresh=1 forces a live run) → 200 ready | 202 running | 429 | 503
   * GET  /api/cases/:id/analysis/progress?key=… → running (with the stages done) | ready | failed
   * POST /api/cases/:id/analysis/verify {input, text} → the verifier's verdict on an edited sentence
   */
  const analysisRoute = async (req: Request, url: URL, caseId: string, sub: string): Promise<Response> => {
    if (!CASE_FILES[caseId]) return json(404, { error: 'UNKNOWN_CASE' });
    const analyst = opts.analyst;
    if (!analyst) return json(503, { error: 'ANALYST_UNAVAILABLE', detail: 'The analyst is not set up on this server' });
    if (sub === '/progress') {
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const key = url.searchParams.get('key') ?? '';
      if (!/^[0-9a-f]{64}$/.test(key)) return json(400, { error: 'INVALID_KEY' });
      // The analysis of a real dispute is the seller's: anyone else gets only analyses of simulated inputs.
      if (!simulatedKeys.has(key) && !(await viewerLive(req))) return json(404, { error: 'NO_ANALYSIS', key });
      const r = analyst.progress(key);
      return json(r.status, r.body);
    }
    if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    // The body carries at most the edited sentence of a re-check. Document data in it is ignored: the input is built
    // here from the server's own fixtures and reads.
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body as { text?: unknown } | null;
    let text = '';
    if (sub === '/verify') {
      text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 600) return json(400, { error: 'INVALID_TEXT', detail: 'text must be 1-600 characters' });
      if (CONTROL_CHARS.test(text) || /[\r\n]/.test(text)) return json(400, { error: 'INVALID_TEXT', detail: 'text must not contain line breaks, control or bidi characters' });
      // A sentence is being edited: whatever this session approved before no longer describes its response. Other
      // sessions' intents are theirs and stay as they are.
      const editor = actorOf(req, false);
      if (editor.ok) intents.invalidateCase(caseId, 'a sentence was edited after this intent was composed', editor.actor);
    }
    const built = await serverInputWith(caseId, req);
    if (built instanceof Response) return built;
    const { input, uploadIds } = built;
    if (sub === '/verify') {
      const r = await analyst.verify(input, text, liveGate(req, 'recheck'));
      if (r.status === 200) {
        const v = r.body as { verdict: Recheck['state']; reason: string | null; citations: Parameters<typeof toCitations>[1]; model: string };
        const key = await analyst.key(input);
        // An upload the check read was deleted meanwhile: nothing of this answer is kept or shown.
        if (uploads.notConfirmed(uploadIds).length) {
          forgetAnalyses([key]);
          return staleUpload();
        }
        const label = v.verdict === 'supported' ? 'supported' : v.verdict === 'rejected' ? 'removed' : 'needs review';
        rememberVerdict(`${key}\n${text}`, { state: v.verdict, reason: v.reason, note: `Edited · re-checked by ${v.model}: ${label}`, citations: toCitations(input, v.citations) });
        const who = actorOf(req, false);
        intents.record({ caseId, kind: 'edit_rechecked', actor: who.ok ? who.actor : 'visitor', ...(who.ok && who.team ? { team: who.team } : {}), detail: `${v.model}: ${label} · text sha256 ${sha256(text).slice(0, 12)}` });
      }
      return json(r.status, r.body);
    }
    const r = await analyst.request(caseId, input, url.searchParams.get('refresh') === '1', liveGate(req, 'live-analysis'));
    // The uploads remember the analyses that read them (deleting one purges those).
    const key = (r.body as { key?: unknown }).key;
    if (uploadIds.length && typeof key === 'string' && (r.status === 200 || r.status === 202)) {
      // An upload deleted between reading it and starting the run: purge what quotes it now, nothing is shown.
      if (uploads.noteAnalysisKey(uploadIds, key).length) {
        forgetAnalyses([key]);
        return staleUpload();
      }
    }
    // The input goes back with the answer: the web app maps the analysis onto exactly these documents.
    return json(r.status, { ...(r.body as object), input });
  };

  const tooManyIntents = (x: { status: number; error: string; detail: string; retryAfterSec?: number }) => {
    const r = json(x.status, { error: x.error, detail: x.detail, ...(x.retryAfterSec ? { retryAfterSec: x.retryAfterSec } : {}) });
    if (x.retryAfterSec) r.headers.set('retry-after', String(x.retryAfterSec));
    return r;
  };

  /**
   * Hosted: a real dispute is answered only by its seller's own people. The person's workspace merchant id must be the
   * seller on the dispute as just read (the gate already hides real disputes from other workspaces; this is the check
   * on the fresh read itself). Local mode has no merchant check: the operator holds the seller's credentials.
   */
  const sellerRefusal = (req: Request, st: CaseState): Response | null => {
    if (!st.dispute || !opts.gate?.merchant) return null;
    const merchant = opts.gate.merchant(req);
    const seller = st.dispute.disputed_transactions?.[0]?.seller?.merchant_id;
    if (merchant && seller && merchant === seller) return null;
    return json(403, { error: 'NOT_THE_SELLER', detail: 'Only the PayPal account that is the seller on this dispute, and the members of its workspace, can respond to it' });
  };

  /** POST /api/disputes/:case/intent → compose the exact content to send, from the server's own case and analysis. */
  const createIntent = async (req: Request, caseId: string): Promise<Response> => {
    // Hosted: intents belong to a demo session, so composing one needs the demo unlock (simulated cases included).
    const who = actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const ir = parseIntentRequest(parsed.body);
    if (isComposeProblem(ir)) return json(ir.status, { error: ir.error, detail: ir.detail });
    // Caps before any expensive work (PayPal read, composing, hashing); nothing changes when refused.
    const full = intents.admit(caseId, who.actor, who.client ?? 'local');
    if (full) return tooManyIntents(full);
    const st = await caseState(caseId, req);
    if (st instanceof Response) return st;
    const notSeller = sellerRefusal(req, st);
    if (notSeller) return notSeller;
    const composed = await compose(caseId, st, ir);
    if (composed instanceof Response) return composed;
    // In the same synchronous step as creating it: every upload in the input (attached or only quoted) is still the
    // confirmed one it was composed from. One deleted or changed while composing never ends up in an intent.
    if (!uploadsUnchanged(st.uploads)) {
      forgetAnalyses([composed.content.analysisKey]);
      return json(409, { error: 'UPLOAD_CHANGED', detail: 'An upload in this response was deleted or changed while it was being composed; nothing was created. Compose it again.' });
    }
    const intent = intents.create(
      { ...composed.content, contentHash: composed.contentHash, request: ir, rechecks: composed.rechecks, createdBy: who.actor, createdFrom: who.client ?? 'local', team: who.team ?? null, analysisHash: composed.analysisHash, inputUploads: st.uploads.map((r) => r.id) },
      composed.analysis,
    );
    if ('ok' in intent) return tooManyIntents(intent);
    return json(201, publicIntent(intent));
  };

  /** POST /api/disputes/:case/intent/:id/approve {contentHash} → the merchant approves exactly that content. */
  const approveIntent = async (req: Request, caseId: string, intentId: string): Promise<Response> => {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const hash = (parsed.body as { contentHash?: unknown } | null)?.contentHash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return json(400, { error: 'INVALID_APPROVAL', detail: 'contentHash (the sha256 of the content you reviewed) is required' });
    // Only the session that composed the intent can approve it; for any other it does not exist.
    const who = actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    const t = intents.approve(intentId, caseId, hash, who.actor);
    if (!t.ok) return json(t.status, { error: t.error, detail: t.detail, ...(t.intent ? { intent: publicIntent(t.intent) } : {}) });
    return json(200, publicIntent(t.intent));
  };

  /**
   * POST /api/disputes/:case/evidence {intentId}: send the approved intent and nothing else. Right before sending,
   * the dispute is read fresh and the intent composed again from it: documents, analysis, sentences, files, tracking
   * and PayPal's allowed actions must all still give the approved content hash.
   */
  const sendIntent = async (req: Request, caseId: string, paypal: PayPalClient, boundId: string): Promise<Response> => {
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'intentId') || typeof body.intentId !== 'string') {
      return json(400, {
        error: 'INVALID_SUBMISSION',
        detail: 'The body must be { "intentId": "<approved intent>" }: notes, files and tracking are composed and approved on the server, never taken from the request',
      });
    }
    const intentId = body.intentId;
    const who = actorOf(req, true);
    if (!who.ok) return json(who.refusal.status, who.refusal.body);
    // Only the owner session's own intent: anyone else's does not exist for this request.
    const i0 = intents.get(intentId, who.actor);
    if (!i0 || i0.caseId !== caseId) return json(404, { error: 'UNKNOWN_INTENT', detail: 'No such submission intent for this case and session' });
    if (i0.disputeId !== boundId) {
      intents.invalidate(intentId, 'the case is bound to another dispute now');
      return json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${i0.disputeId ?? 'the simulator'}; the case is bound to ${boundId} now` });
    }

    // One send at a time: of two concurrent confirmations, exactly one gets past this synchronous transition.
    const claim = intents.beginSend(intentId, caseId, who.actor);
    if (!claim.ok) return json(claim.status, { error: claim.error, detail: claim.detail, ...(claim.intent ? { intent: publicIntent(claim.intent) } : {}) });
    const intent = claim.intent;
    const refuse = (res: Response, why: string, invalidate: boolean): Response => {
      if (invalidate) intents.invalidate(intentId, why, who.actor);
      else intents.revert(intentId, claim.previous);
      intents.record({ caseId, kind: 'send_refused', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId, detail: why });
      return res;
    };

    // Hosted demo: sending to real PayPal needs the demo code and stays within the daily cap.
    const reserved = opts.gate?.reserve(req, 'evidence');
    if (reserved && !reserved.ok) return refuse(json(reserved.refusal.status, reserved.refusal.body), String((reserved.refusal.body as { error?: string }).error ?? reserved.refusal.status), false);
    let sending = false;
    try {
      const st = await caseState(caseId, req);
      if (st instanceof Response) {
        const b = (await st.clone().json().catch(() => ({}))) as { error?: string };
        return refuse(st, b.error ?? `refused (${st.status})`, b.error === 'BINDING_INVALID');
      }
      if (!st.dispute) return refuse(json(409, { error: 'NOT_BOUND', detail: 'PayPal is not connected for this case now' }), 'PayPal not connected', false);
      // What was just read and verified must be the very dispute this intent was approved for (the case may have moved
      // to the next dispute of its reserve in between; the content hash would differ too, this says why).
      if (st.disputeId !== boundId) {
        return refuse(json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${boundId}; the case is bound to ${st.disputeId} now` }), 'the case moved to another dispute', true);
      }
      // On the dispute as just read: the person must act for its seller.
      const notSeller = sellerRefusal(req, st);
      if (notSeller) return refuse(notSeller, 'not the seller on this dispute', true);
      // PayPal takes the seller's evidence once. If it already has some (another session sent first), this intent is
      // over: say so plainly instead of composing it again.
      if (st.snap && hasSellerEvidence(st.snap)) {
        return refuse(json(409, { error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent' }), 'PayPal already has seller evidence', true);
      }
      if (sha256(documentsSignature(st.input)) !== intent.documentsHash) {
        // Most often a colleague confirmed an upload since this was composed: name it.
        const added = intent.inputUploads ? st.uploads.filter((r) => !intent.inputUploads!.includes(r.id)).sort((a, b) => evidenceNumber(a.evidenceId) - evidenceNumber(b.evidenceId)) : [];
        const detail = added.length
          ? `${added[0]!.uploadedBy.name} added evidence ${added[0]!.evidenceId}${added.length > 1 ? ` and ${added.length - 1} more` : ''} since you approved; review again`
          : 'The case documents changed since you approved this response; review it again';
        return refuse(json(409, { error: 'DOCUMENTS_CHANGED', detail }), 'documents changed', true);
      }
      // An intent approved before every file carried its SHA-256 cannot be checked byte for byte: compose it again.
      if (intent.files.some((f) => !f.sha256)) {
        return refuse(json(409, { error: 'INTENT_STALE', detail: 'This response was approved before ResolveKit recorded each file’s SHA-256; review it again' }), 'no file hashes', true);
      }
      const again = await compose(caseId, st, intent.request, intent.rechecks, intents.analysisPin(intent.analysisHash));
      if (again instanceof Response) {
        const b = (await again.clone().json().catch(() => ({}))) as { error?: string };
        // PayPal's or MeterMCP's being unreachable is not a change of content: the intent may be sent later.
        return refuse(again, `composing again failed: ${b.error ?? again.status}`, again.status !== 503 && again.status !== 502);
      }
      for (const f of intent.files.filter((x) => x.source === 'upload')) {
        if (again.content.files.find((x) => x.name === f.name)?.sha256 !== f.sha256) {
          return refuse(json(409, { error: 'UPLOAD_CHANGED', detail: `The stored file ${f.name} is not the one you approved; review it again` }), 'upload changed', true);
        }
      }
      if (again.contentHash !== intent.contentHash) {
        return refuse(json(409, { error: 'INTENT_STALE', detail: 'What would be sent now differs from what you approved (analysis, sentences, files or tracking changed); review it again' }), 'content changed', true);
      }

      // Exactly the bytes whose SHA-256 the approval covers (the hashes are equal): the case's own PDFs or the agent
      // case's real MeterMCP receipt, and the selected uploads as stored.
      const files = again.attachments;
      const sid = isAgentCase(caseId) && st.snap?.agentReceipt?.kind === 'metermcp' ? st.snap.agentReceipt.session.sessionId : null;

      // The send_started line must be on disk before PayPal is called: an evidence submission is never missing from
      // the trail.
      const started = intents.recordChecked({ caseId, kind: 'send_started', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId });
      if (!started.durable) {
        log(`AUDIT UNAVAILABLE: send_started not written · case ${caseId} · intent ${intentId}; nothing sent`);
        return refuse(json(503, { error: 'AUDIT_UNAVAILABLE', detail: 'The send could not be recorded durably, so nothing was sent; try again later' }), 'audit log unavailable', false);
      }
      sending = true;
      const tracking = { carrier_name: intent.carrier, tracking_number: intent.tracking, ...(intent.carrier === 'OTHER' ? { carrier_name_other: 'Digital delivery' } : {}) };
      try {
        await paypal.disputes.provideEvidence(
          boundId,
          // Tracking info only goes with a carrier and a reference (proof of fulfillment); OTHER is notes and documents.
          intent.carrier && intent.tracking
            ? { evidence_type: intent.evidenceType, evidence_info: { tracking_info: [tracking] }, notes: intent.notes }
            : { evidence_type: intent.evidenceType, notes: intent.notes },
          files,
          // One PayPal-Request-Id per intent: a retry of the same intent is the same request.
          { requestId: intent.requestId },
        );
      } catch (e) {
        intents.failed(intentId, who.actor, failureText(e));
        return fromPayPalError(e);
      }
      if (!intents.sent(intentId, who.actor, 'accepted by PayPal (read back to confirm)')) {
        // PayPal has the evidence; only our record of the outcome is not durable. send_started is on disk, so after a
        // restart the intent reads PayPal back (seller evidence present) instead of sending again.
        log(`AUDIT NOT DURABLE: outcome of intent ${intentId} (case ${caseId} -> ${boundId}) not written; PayPal accepted it`);
      }
      log(`provide-evidence sent · case ${caseId} → ${boundId} · ${intent.evidenceType} · ${files.length} file(s)${sid ? ` · MeterMCP receipt ${sid}` : ''} · intent ${intentId} · request ${intent.requestId}`);
      // Accepted by PayPal is not "recorded": the client reads the dispute back to find out what PayPal stored.
      return json(202, { sent: true, intent: publicIntent(intents.get(intentId, who.actor)!) });
    } catch (e) {
      if (!sending) intents.revert(intentId, claim.previous);
      throw e;
    } finally {
      if (!sending && reserved?.ok) reserved.release();
    }
  };

  /**
   * What verified PayPal webhooks said, newest first, as this server re-read each dispute: shown to the dispute's
   * seller only (hosted), including disputes not bound to any case yet (a new dispute arrives this way).
   */
  interface Notice {
    eventId: string;
    eventType: string;
    disputeId: string;
    caseId: string | null;
    /** The seller's merchant id, from PayPal's own read of the dispute (never from the payload). */
    merchant: string | null;
    status: string | null;
    reason: string | null;
    amount: { value: string; currency: string } | null;
    at: string;
  }
  const notices: Notice[] = [];
  const MAX_NOTICES = 50;
  const DISPUTE_ID = /^PP-[A-Z0-9-]{4,40}$/;
  const WEBHOOK_READ_WAITS_MS = opts.webhookReadWaitsMs ?? [0, 2_000, 10_000];

  const paypalNotified = async (e: WebhookEvent): Promise<void> => {
    if (!e.event_type.startsWith('CUSTOMER.DISPUTE.')) return log(`paypal webhook · ${e.id} · ${e.event_type} ignored (not a dispute event)`);
    const disputeId = e.resource?.dispute_id;
    if (typeof disputeId !== 'string' || !DISPUTE_ID.test(disputeId)) return log(`paypal webhook · ${e.id} · no usable dispute id`);
    const paypal = opts.paypal;
    if (!paypal) return;
    const caseId = Object.keys(opts.bindings).find((k) => bindingOf(k)?.dispute === disputeId) ?? null;
    // The next view of the case reads PayPal again, even inside the read cache's lifetime.
    if (caseId) reads.delete(caseId);
    // PayPal will not deliver an acknowledged event again, so a failed read is retried here a few times.
    let d: Dispute | null = null;
    let lastError: unknown = null;
    for (const wait of WEBHOOK_READ_WAITS_MS) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        d = await paypal.disputes.get(disputeId);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!d) return log(`paypal webhook · ${e.id} · dispute ${disputeId} could not be read (${failureText(lastError)}) · it is read again when the case is opened`);
    const merchant = d.disputed_transactions?.[0]?.seller?.merchant_id ?? null;
    if (caseId) noteSeller(caseId, d);
    const amount = d.dispute_amount?.value && d.dispute_amount.currency_code ? { value: d.dispute_amount.value, currency: d.dispute_amount.currency_code } : null;
    const at = now().toISOString();
    notices.unshift({ eventId: e.id, eventType: e.event_type, disputeId, caseId, merchant, status: d.status ?? null, reason: d.reason ?? null, amount, at });
    if (notices.length > MAX_NOTICES) notices.length = MAX_NOTICES;
    if (caseId) {
      // One audit bucket per seller workspace, so one busy merchant cannot push another's history out.
      const team = merchant ? workspaceIdFor(merchant) : null;
      intents.record({ caseId, kind: 'paypal_notified', actor: 'PayPal (webhook)', owner: `PayPal (webhook) · ${team ?? 'unknown seller'}`, ...(team ? { team } : {}), disputeId, detail: `${e.event_type} · dispute ${disputeId} is ${d.status ?? 'without status'} at PayPal` });
    }
    log(`paypal webhook · ${e.id} · dispute ${disputeId} re-read · ${d.status ?? '?'}${caseId ? ` · case ${caseId}` : ' · not bound to a case'}`);
  };

  /** GET /api/paypal/notices: the viewer's own (hosted: the signed-in merchant's disputes; local: all). */
  const noticesFor = (req: Request): Response => {
    const merchant = opts.gate ? (opts.gate.merchant?.(req) ?? null) : undefined;
    const visible = merchant === undefined ? notices : merchant ? notices.filter((n) => n.merchant === merchant) : [];
    return json(200, { notices: visible.map(({ merchant: _m, ...n }) => n) });
  };

  /** Merchant evidence uploads: the seller's workspace (local: the operator), the case's active dispute. */
  const uploadRoutes = createUploadRoutes({
    store: uploads,
    person: personOf,
    isLive: (req) => viewerLive(req),
    reserve: opts.gate ? (req) => opts.gate!.reserve(req, 'upload') : null,
    caseBinding: (caseId) => bindingOf(caseId)?.dispute ?? null,
    record: (e) => intents.record(e),
    // Deletion wins over reuse: an unsent intent attaching or quoting the upload is void; a send in flight is waited for.
    attachedTo: {
      sending: (id) => intents.usingUpload(id).some((i) => i.status === 'sending'),
      invalidate: (rec, actor) => {
        for (const i of intents.usingUpload(rec.id)) {
          if (i.status === 'sending') continue;
          const how = i.request.attachments?.includes(rec.id) ? 'it attaches' : 'it was composed with';
          intents.invalidate(i.id, `evidence ${rec.evidenceId ?? rec.id} ${how} was deleted`, actor);
        }
      },
    },
    // Deleting an upload forgets what quotes it: stored analyses, jobs and progress, re-check verdicts, the case's pin.
    purge: (keys, caseId, uploadId) => {
      forgetAnalyses(keys);
      intents.dropPinsUsing(uploadId);
      pins.forget(caseId);
    },
    log,
    now,
    ...(opts.uploadStorageBytes ? { maxStorageBytes: opts.uploadStorageBytes } : {}),
    ...(opts.uploadStoredFileBytes ? { maxStoredBytes: opts.uploadStoredFileBytes } : {}),
  });

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/api/paypal/notices') return req.method === 'GET' ? noticesFor(req) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    // Local mode has no demo lock; answering here keeps the web app's lock check from logging a 404.
    if (path === '/api/demo' && req.method === 'GET') return json(200, { hosted: false });
    if (path === '/api/health' && req.method === 'GET') {
      const h = await checkHealth();
      // Hosted: the real disputes are listed only to the seller's workspace; everyone else runs them on the simulator.
      const live = await viewerLive(req);
      const bound = h.paypal === 'unconfigured' || !live ? [] : Object.keys(opts.bindings).filter((k) => bindingOf(k));
      return json(200, { ...h, bound, bindings: Object.fromEntries(bound.map((k) => [k, bindingState(k)])) });
    }
    const a = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/analysis(\/progress|\/verify)?$/.exec(path);
    if (a) return analysisRoute(req, url, a[1]!, a[2] ?? '');
    const up = await uploadRoutes(req, url);
    if (up) return up;
    const m = /^\/api\/disputes\/([A-Za-z0-9-]{1,64})(?:\/(evidence|intent|audit)(?:\/(int-[0-9a-f]{32})(\/approve|\/cancel)?)?)?$/.exec(path);
    if (!m) return json(404, { error: 'NOT_FOUND' });
    const caseId = m[1]!;
    const sub = m[2];
    const intentId = m[3];

    // Intents and the audit log exist for every case: a simulated case's intent is approved here too, and the
    // in-browser simulator records it.
    if (sub === 'intent' || sub === 'audit') {
      if (!CASE_FILES[caseId]) return json(404, { error: 'UNKNOWN_CASE' });
      if (!intentId && sub === 'intent') return req.method === 'POST' ? createIntent(req, caseId) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      if (m[4] === '/approve') return req.method === 'POST' ? approveIntent(req, caseId, intentId!) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      // Reads, cancels and the audit trail: the session's own (hosted: needs the demo unlock).
      const who = actorOf(req, true);
      if (!who.ok) return json(who.refusal.status, who.refusal.body);
      if (sub === 'audit') {
        if (intentId || req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
        // Local: the operator sees the case's whole trail. Hosted: a workspace's members see the workspace's trail.
        return json(200, { events: intents.events(caseId, opts.gate ? (who.team ? { team: who.team } : who.actor) : undefined) });
      }
      if (m[4] === '/cancel') {
        if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
        const t = intents.cancel(intentId!, caseId, who.actor);
        return t.ok ? json(200, publicIntent(t.intent)) : json(t.status, { error: t.error, detail: t.detail });
      }
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const i = intents.get(intentId!, who.actor);
      return i && i.caseId === caseId ? json(200, publicIntent(i)) : json(404, { error: 'UNKNOWN_INTENT' });
    }
    if (intentId) return json(404, { error: 'NOT_FOUND' });

    const disputeId = bindingOf(caseId)?.dispute;
    if (!disputeId) return json(404, { error: 'NOT_BOUND', detail: `Case ${caseId} is not bound to a PayPal dispute` });
    // Sending needs a signed-in person first (hosted); then, a real dispute is the seller's: for anyone else this case
    // runs on the simulator.
    if (sub === 'evidence') {
      const who = actorOf(req, true);
      if (!who.ok) return json(who.refusal.status, who.refusal.body);
    }
    if (!(await viewerLive(req))) return json(404, { error: 'NOT_BOUND', detail: `Case ${caseId} runs on the simulator for this workspace` });
    const paypal = opts.paypal;
    if (!paypal) return json(503, { error: 'PAYPAL_UNCONFIGURED' });

    if (!sub && req.method === 'GET') {
      try {
        return json(200, await readCase(caseId, disputeId, paypal));
      } catch (e) {
        return fromPayPalError(e);
      }
    }
    if (sub === 'evidence' && req.method === 'POST') return sendIntent(req, caseId, paypal, disputeId);
    return json(405, { error: 'METHOD_NOT_ALLOWED' });
  };

  return Object.assign(route, {
    inputFor: (caseId: string) => serverInput(caseId),
    sellerIds,
    sellerName,
    forgetReads: () => {
      reads.clear();
      sellers.clear();
      bindingStatus.clear();
      intents.invalidateAll('the bindings changed');
    },
    paypalNotified,
    intents,
    opsReport,
    personOf,
  });

  /** Each binding read from PayPal now (the same read and check as before a send), whoever asks. */
  async function opsReport(): Promise<OpsReport> {
    const h = await checkHealth();
    const bindings: OpsReport['bindings'] = {};
    for (const caseId of Object.keys(opts.bindings)) {
      const b = bindingOf(caseId);
      if (!b) continue;
      if (h.paypal !== 'unconfigured') {
        try {
          await caseState(caseId);
        } catch (e) {
          bindingStatus.set(caseId, { status: 'unavailable', reasons: [failureText(e)], checkedAt: now().toISOString(), binding: b });
        }
      }
      // The read may have moved the case to the next dispute of its reserve: report the one that is active now.
      const active = bindingOf(caseId) ?? b;
      const st = bindingState(caseId);
      bindings[caseId] = {
        dispute: active.dispute,
        capture: active.capture,
        status: st?.status ?? 'unchecked',
        reasons: st?.reasons ?? [],
        checkedAt: st?.checkedAt ?? null,
        used: usedNow.get(caseId) ?? false,
        reserve: opts.reserve?.[caseId]?.length ?? 0,
      };
    }
    return { ...h, bindings };
  }
}

/** The record of a stored intent, for tests. */
export type { StoredIntent };
