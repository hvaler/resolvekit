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
import type { AgentReceiptSource, AgentRunSummary, DisputeSnapshot, SubmissionFile } from '../../web/src/domain/types.ts';
import { linesToConfirmOf, type Recheck } from '../../web/src/domain/draft.ts';
import { composeSubmission, contentHash, isComposeProblem, parseIntentRequest, type IntentContent, type IntentRequest } from '../../web/src/domain/intent.ts';
import { evidenceAfterEscalationRefusal, hasSellerEvidence, sellerEvidence, sellerEvidenceBlocks } from '../../web/src/domain/recorded.ts';
import { InputPins, type AnalystService, type LiveGate, type Reservation } from './analysis.ts';
import { toBinding, verifyBinding, type Binding, type BindingState } from './bindings.ts';
import { buildAttachments, CASE_FILES, UnknownFileError } from './documents.ts';
import { failureText, isTimeout, json, paypalIssue, readJson, tooMany } from './http.ts';
import { IntentStore, publicIntent, requestAttachments, type DisputeHold, type StoredIntent } from './intents.ts';
import { intentAction, isActionRequest, isSimpleAction, type ContractRegistry, type RulesOf, type SimpleAction } from '../../web/src/domain/actions.ts';
import { CONTRACTS } from '../../web/src/domain/actionContracts.ts';
import { createActionRoutes } from './actions/routes.ts';
import type { ReserveMemory } from './reserve.ts';
import { RecheckVerdicts } from './verdicts.ts';
import { MeterMcpError, receiptFileName, toMeteredSession, type MeterMcpSource } from './metermcp.ts';
import { toSnapshot } from './mapping.ts';
import { checkAgainstDispute } from './validate.ts';
import { createPdfJob } from './uploads/pdf-job.ts';
import { REFUSED_EARLY, acceptsFileBody, createUploadRoutes } from './uploads/routes.ts';
import { uploadDocuments, uploadFileName } from './uploads/documents.ts';
import { UploadStore, type UploadRecord } from './uploads/store.ts';
import { PAYPAL_MAX_SEND_BYTES } from './uploads/limits.ts';
import { createAgentRoutes } from './agent/routes.ts';
import type { AgentService } from './agent/service.ts';

/** Actions that cost money or quota, or cannot be undone: a hosted demo may refuse them (see {@link CostGate}). */
export type CostlyAction = 'evidence' | 'live-analysis' | 'recheck' | 'upload' | 'agent-run' | 'message' | 'settle';

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
  /**
   * Hosted: whether this request's workspace is the seller of this bound case (the case's own dispute as last read,
   * or remembered for the same case and dispute). Absent (local mode): yes.
   */
  seesCase?(req: Request, caseId: string): Promise<boolean>;
  /** Hosted: count `pages` PDF page reads against the address's upload limit, all or none. Absent: not metered. */
  meterPages?(req: Request, pages: number): Reservation;
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
  /** Remembers the disputes a case moved past, so a restart does not walk past them again (reserve.ts). Default: none. */
  reserveMemory?: ReserveMemory | null;
  /** How long a dispute whose seller evidence just went in stays active, so whoever sent it sees PayPal's read-back (15 min). */
  rotateAfterMs?: number;
  /** The verifier's verdicts on edited sentences (verdicts.ts; persisted on the data dir by main.ts). Default: in memory. */
  verdicts?: RecheckVerdicts | null;
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
  /** Total size of the files of one response (default PAYPAL_MAX_SEND_BYTES, uploads/limits.ts). */
  paypalMaxSendBytes?: number;
  /** The buying agent's runs (/api/agent/runs, agent/routes.ts). null/absent: those routes answer 503. */
  agent?: AgentService | null;
  /**
   * Tests only: the action routes against a test-only contract registry and rules (production: CONTRACTS and
   * ACTION_RULES, which no test changes).
   */
  actionRegistry?: { contracts: ContractRegistry; rules: Readonly<Partial<Record<SimpleAction, RulesOf>>> } | null;
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
 * image/png, image/jpeg and application/pdf (not "simple" types either).
 */
export function guard(req: Request, opts: Pick<AppOptions, 'port' | 'token' | 'allowedOrigins'>): Response | null {
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (host !== `127.0.0.1:${opts.port}` && host !== `localhost:${opts.port}`) return json(403, { error: 'FORBIDDEN_HOST' });
  const origin = req.headers.get('origin');
  if (origin != null && !opts.allowedOrigins.includes(origin)) return json(403, { error: 'FORBIDDEN_ORIGIN' });
  const token = req.headers.get(TOKEN_HEADER);
  if (!opts.token || !token || !sameSecret(token, opts.token)) return json(401, { error: 'MISSING_OR_BAD_TOKEN' });
  const type = req.headers.get('content-type');
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(type ?? '') && !acceptsFileBody(req.method, new URL(req.url).pathname, type)) {
    return json(415, { error: 'UNSUPPORTED_MEDIA_TYPE', detail: 'POST bodies must be application/json (an evidence upload may be image/png, image/jpeg or application/pdf)' });
  }
  return null;
}

export type Handler = (req: Request) => Promise<Response>;

// The shared HTTP helpers (http.ts); `json` is re-exported for the modules that import it from here.
export { json };

/** A PayPal failure as an API answer. Never includes request headers, tokens or credentials. */
function fromPayPalError(e: unknown): Response {
  if (e instanceof PayPalError) {
    const status = e.status === 404 ? 404 : e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403 ? 422 : 502;
    return json(status, { error: e.message, paypalIssue: paypalIssue(e), paypalStatus: e.status, debugId: e.debugId ?? undefined });
  }
  if (isTimeout(e)) return json(504, { error: 'PAYPAL_TIMEOUT' });
  return json(502, { error: 'PAYPAL_UNREACHABLE' });
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
/** One read of the sellers of the bound disputes: per bound case (`read` false: unreadable now), plus the derived set. */
export interface SellerRead {
  ids: Set<string>;
  /** Every bound dispute was read. */
  complete: boolean;
  cases: Array<{ caseId: string; dispute: string; read: boolean; merchant: string | null }>;
}
/** The API handler, plus the analyst's input as the server builds it (hosted warm-up, tests). */
export type Api = Handler & {
  inputFor: (caseId: string) => Promise<AnalysisInput | Response>;
  /** The PayPal merchant ids that are the seller on a bound dispute (hosted: whose workspace sees real PayPal). */
  sellerIds: () => Promise<Set<string>>;
  /** The same read, telling whether every bound dispute could be read (`complete`). */
  sellerRead: () => Promise<SellerRead>;
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
  /**
   * The operator's read-back of the send holding a dispute (hosted POST /api/ops/readback/:id, behind the ops token):
   * reads PayPal and records what it proves; never POSTs to PayPal.
   */
  opsReadBack: (intentId: string) => Promise<Response>;
  /** The person acting on a request (see {@link ActingPerson}); null when signed out. */
  personOf: (req: Request) => ActingPerson | null;
};

/** What the operator's check sees: PayPal connected, and each bound case's binding as a fresh read verified it. */
export interface OpsReport {
  paypal: PayPalEnv | 'unconfigured';
  error?: string;
  /** Stores whose file could not be read at start (preserved aside, see intents.ts), with why. Empty: none. */
  storage: string[];
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
      /** The send holding the active dispute (in flight, else unproven: rotation waits for its read-back), or null. */
      held: { intentId: string; since: string } | null;
    }
  >;
  /** Every dispute held by a send in flight or unproven (reserves included), and whether its intent is still known. */
  holds: DisputeHold[];
}

/** sha256 hex of a string. */
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const evidenceNumber = (id: string | null) => Number(/^E(\d+)$/.exec(id ?? '')?.[1] ?? 0);

/** The case as the server sees it right now: where PayPal's data comes from, and the analyst's input. */
export interface CaseState {
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
  /**
   * The verifier's verdicts on edited sentences, by analysis key and text: only these edits can be sent. Bounded, the
   * oldest first (an intent keeps the verdicts it was composed with); persisted when main.ts gives a file.
   */
  const verified = opts.verdicts ?? new RecheckVerdicts();

  /** Forget the analyses with these keys and everything that hangs from them (job, progress, stored file, re-check verdicts). */
  const forgetAnalyses = (keys: string[]) => {
    opts.analyst?.forget(keys);
    verified.forget(keys);
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

  /** Hosted: whether the request's workspace is this case's seller (snapshots carry the thread's text). Local: yes. */
  const sellerOfCase = async (req: Request, caseId: string): Promise<boolean> => !opts.gate?.seesCase || (await opts.gate.seesCase(req, caseId));
  /**
   * Whether this request may address the case at all. Local: any fixture case. Hosted: only a bound case, and only
   * for the workspace of that case's own seller; everything else is UNKNOWN_CASE (three-environments plan, task 2).
   */
  const caseVisible = async (req: Request, caseId: string): Promise<boolean> =>
    Object.hasOwn(CASE_FILES, caseId) && (!opts.gate || (!!bindingOf(caseId) && ownerSees(req, caseId) && (await viewerLive(req)) && (await sellerOfCase(req, caseId))));
  /** An owner-only case (the settlement case) exists only for the workspace's owner; anyone else: UNKNOWN_CASE. */
  const ownerSees = (req: Request, caseId: string): boolean => CASE_FILES[caseId]?.audience !== 'owner' || personOf(req)?.role === 'owner';

  /** The seller's PayPal merchant id on each bound dispute, from the last read of it. */
  const sellers = new Map<string, { dispute: string; merchant: string | null; name: string | null }>();
  const noteSeller = (caseId: string, d: Dispute) => {
    const s = d.disputed_transactions?.[0]?.seller;
    const dispute = d.dispute_id ?? '';
    // The same dispute read again without a merchant id keeps the seller already known for it: a sparse answer must
    // not hide the case from its seller until the binding rotates.
    const known = sellers.get(caseId);
    const keep = known && known.dispute === dispute && !s?.merchant_id ? known : null;
    sellers.set(caseId, { dispute, merchant: s?.merchant_id ?? keep?.merchant ?? null, name: s?.name ?? keep?.name ?? null });
  };
  /** The seller's name as PayPal gives it on a bound dispute (after {@link sellerIds} read them), or null. */
  const sellerName = (merchantId: string): string | null => [...sellers.values()].find((s) => s.merchant === merchantId && s.name)?.name ?? null;
  /** The merchant ids that are the seller on a bound dispute (each dispute read once, then on every fresh read). */
  // Single-flight: concurrent requests share the read in progress.
  let sellerFlight: Promise<SellerRead> | null = null;
  const sellerRead = (): Promise<SellerRead> =>
    (sellerFlight ??= readSellers().finally(() => {
      sellerFlight = null;
    }));
  const readSellers = async (): Promise<SellerRead> => {
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
    const ids = new Set<string>();
    const cases: SellerRead['cases'] = [];
    for (const caseId of Object.keys(opts.bindings)) {
      const b = bindingOf(caseId);
      if (!b) continue;
      const s = sellers.get(caseId);
      const read = s?.dispute === b.dispute;
      // A dispute that names no seller counts as read.
      cases.push({ caseId, dispute: b.dispute, read, merchant: read ? (s?.merchant ?? null) : null });
      if (read && s?.merchant) ids.add(s.merchant);
    }
    return { ids, complete: cases.every((c) => c.read), cases };
  };
  const sellerIds = async (): Promise<Set<string>> => (await sellerRead()).ids;

  /**
   * The MeterMCP session behind the dispute's disputed capture. `none` (with the reason) when there is no capture,
   * no MeterMCP, or no session for it; throws MeterMcpError when MeterMCP cannot be asked. The run's summary goes with
   * it only by {@link boundRun}.
   */
  const agentReceipt = async (caseId: string, d: Dispute): Promise<AgentReceiptSource> => {
    const capture = d.disputed_transactions?.[0]?.seller_transaction_id;
    if (!capture) return { kind: 'none', reason: 'PayPal reports no disputed capture' };
    if (!opts.meterMcp) return { kind: 'none', reason: 'MeterMCP is not configured on this server' };
    const sessionId = await opts.meterMcp.findByCapture(capture);
    if (!sessionId) return { kind: 'none', reason: `MeterMCP has no session for capture ${capture}` };
    const session = toMeteredSession(await opts.meterMcp.receipt(sessionId));
    const run = boundRun(caseId, d, sessionId);
    return run ? { kind: 'metermcp', session, run } : { kind: 'metermcp', session };
  };
  /** The run each agent case last attached as E5 (`<dispute>|<run>`), so the log line says only what changed. */
  const attachedRuns = new Map<string, string>();
  /**
   * The run record shown as the agent case's E5 (Ruling A14): only the run the case's active binding names
   * (`run`, written by demo:prepare: the owner's act of publishing it as evidence), for this dispute, and only when
   * its session is this capture's session (and the binding's `session`, when given). A run that merely holds the
   * session is never shown: the case snapshot is shared by every viewer of the case. Only the goal, the steps'
   * reasons and summaries and the outcome; never the person, the approval link or the order.
   */
  const boundRun = (caseId: string, d: Dispute, sessionId: string): AgentRunSummary | null => {
    const b = bindingOf(caseId);
    const found = b?.run && b.dispute === d.dispute_id ? opts.agent?.store.get(b.run) : undefined;
    const r = found && found.sessionId === sessionId && (!b?.session || b.session === found.sessionId) ? found : null;
    // Every snapshot build asks: logged when what is attached changes, not on each read of the case.
    const attached = r ? `${d.dispute_id}|${r.id}` : null;
    if (attached !== (attachedRuns.get(caseId) ?? null)) {
      if (attached) attachedRuns.set(caseId, attached);
      else attachedRuns.delete(caseId);
      if (r) log(`agent case ${caseId}: run record ${r.id} attached (E5)`);
    }
    if (!r) return null;
    const steps = r.steps.map((x) => ({ n: x.n, tool: x.tool, state: x.state, reason: x.reason, summary: x.summary }));
    return { runId: r.id, goal: r.goal, outcome: r.state, stopReason: r.stopReason, steps };
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
        receipt = await agentReceipt(caseId, d);
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
  const uploads = opts.uploads ?? new UploadStore({ dir: null, now });
  /** The stores whose file could not be read at start (each preserved aside, with why): /api/health and the ops check. */
  const storageProblems = (): Array<{ store: string; problem: string }> =>
    [
      { store: 'intents', problem: intents.storageProblem() },
      { store: 'analysis-inputs', problem: pins.storageProblem() },
      { store: 'recheck-verdicts', problem: verified.storageProblem() },
      { store: 'reserve-position', problem: opts.reserveMemory?.storageProblem() ?? null },
    ].filter((p): p is { store: string; problem: string } => !!p.problem);
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
  /** The registry evidence is checked against (a test-only one when the action routes get one). */
  const evidenceContracts = () => opts.actionRegistry?.contracts ?? CONTRACTS;
  /**
   * Whether the seller has acted on the dispute: seller evidence, a seller message in the thread, or an action this
   * server's send log proved recorded. Then PayPal's links have moved on but the documents have not, so the analyst's
   * input stays the pinned one of the same documents (no new analysis, the same key).
   */
  const sellerActed = (snap: DisputeSnapshot, disputeId: string | null | undefined): boolean =>
    hasSellerEvidence(snap) || (snap.messages ?? []).some((m) => m.postedBy === 'SELLER') || (!!disputeId && intents.hasRecordedAction(disputeId));
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
    const submitted = source.kind === 'live' && sellerActed(source.snap, disputeId);
    const recs = await confirmedUploads(caseId, disputeId ?? null, req);
    const input = withUploads(pins.resolve(caseId, caseInput(demo, source), submitted), recs);
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
    const state = { source, input: withUploads(pins.resolve(caseId, caseInput(demo, source), sellerActed(snap, disputeId)), recs), dispute, snap, disputeId, uploads: recs };
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
    // An action on it is in flight, or its outcome is unproven (awaiting a read-back): the case stays, and it is not
    // remembered as used, so whoever sent it reads PayPal's answer on the same dispute.
    if (intents.held(binding.dispute)) return;
    const next = queue.shift()!;
    (opts.bindings as Record<string, string | Binding>)[caseId] = next;
    // Remembered on the data dir: after a restart the case starts past it (reserve.ts), not at the first entry again.
    opts.reserveMemory?.markUsed(caseId, binding.dispute);
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
        const r = rechecks ? (id ? rechecks[id] : undefined) : verified.get(a.key, text);
        if (r && id) used[id] = r;
        return r ?? null;
      },
      allowedActions: caseAllowedActions(st.source, undefined, demo.allowedActions),
      // Any seller evidence blocks more (evidence once; W-6 only opens the claim of a dispute with none).
      submitted: !!st.snap && sellerEvidenceBlocks(st.snap),
      // From the uploads in the input this server built: the same corrected and transcribed lines the web app shows.
      corrections: linesToConfirmOf(st.input.documents),
    });
    if (isComposeProblem(composed)) return json(composed.status, { error: composed.error, detail: composed.detail, ...(composed.blockers ? { blockers: composed.blockers } : {}) });
    const s = composed.submission;
    if (st.dispute) {
      const problem = checkAgainstDispute(s, st.dispute);
      if (problem) return json(problem.status, { error: problem.error, detail: problem.detail });
    }
    // After the seller's escalation, evidence only as recorded (W-6: the claim waiting for the seller).
    const late = st.snap ? evidenceAfterEscalationRefusal(st.snap, evidenceContracts()) : null;
    if (late) return json(409, { error: 'VARIANT_NOT_AVAILABLE', detail: late });
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
      // A screenshot goes as its PNG (a covered photo as its JPEG); pasted text and a PDF (rebuilt from its covered
      // pages) as their stored sanitised.pdf.
      const type = r.kind === 'image' ? (r.mime === 'image/png' || r.mime === 'image/jpeg' ? r.mime : null) : r.mime === 'application/pdf' ? r.mime : null;
      if (!bytes || !type || !r.sha256 || sha256(bytes) !== r.sha256) {
        return json(409, { error: 'UPLOAD_CHANGED', detail: `The stored file of ${r.evidenceId} no longer matches the one confirmed; it is not attached` });
      }
      const name = uploadFileName(r);
      out.push({ file: { name, size: `${Math.max(1, Math.round(bytes.length / 1024))} KB`, sha256: r.sha256, source: 'upload' }, data: { name, type, data: bytes } });
    }
    const total = out.reduce((n, f) => n + f.data.data.length, 0);
    const limit = opts.paypalMaxSendBytes ?? PAYPAL_MAX_SEND_BYTES;
    if (total > limit) {
      return json(422, { error: 'ATTACHMENTS_TOO_LARGE', detail: `The files of this response total ${total.toLocaleString('en-US')} bytes; PayPal accepts up to ${limit.toLocaleString('en-US')} bytes per response. Deselect an upload and compose it again.` });
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

  /**
   * POST /api/cases/:id/analysis {input} (?refresh=1 forces a live run) → 200 ready | 202 running | 429 | 503
   * GET  /api/cases/:id/analysis/progress?key=… → running (with the stages done) | ready | failed
   * POST /api/cases/:id/analysis/verify {input, text} → the verifier's verdict on an edited sentence
   */
  const analysisRoute = async (req: Request, url: URL, caseId: string, sub: string): Promise<Response> => {
    if (!(await caseVisible(req, caseId))) return json(404, { error: 'UNKNOWN_CASE' });
    const analyst = opts.analyst;
    if (!analyst) return json(503, { error: 'ANALYST_UNAVAILABLE', detail: 'The analyst is not set up on this server' });
    if (sub === '/progress') {
      if (req.method !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });
      const key = url.searchParams.get('key') ?? '';
      if (!/^[0-9a-f]{64}$/.test(key)) return json(400, { error: 'INVALID_KEY' });
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
        // An upload the check read was deleted meanwhile: nothing of this answer is kept or shown. Otherwise the uploads
        // remember the key, so deleting one sweeps this verdict too.
        if (uploadIds.length && uploads.noteAnalysisKey(uploadIds, key).length) {
          forgetAnalyses([key]);
          return staleUpload();
        }
        const label = v.verdict === 'supported' ? 'supported' : v.verdict === 'rejected' ? 'removed' : 'needs review';
        verified.set(key, text, { state: v.verdict, reason: v.reason, note: `Edited · re-checked by ${v.model}: ${label}`, citations: toCitations(input, v.citations) });
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


  /**
   * Hosted: a real dispute is answered only by its seller's own people. The person's workspace merchant id must be the
   * seller on the dispute as just read (the gate already hides real disputes from other workspaces; this is the check
   * on the fresh read itself). Local mode has no merchant check: the operator holds the seller's credentials.
   */
  const sellerRefusal = (req: Request, st: Pick<CaseState, 'dispute'>): Response | null => {
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
    // An appeal is the owner's only, and not available until its contract is recorded and its flow built (Task 12).
    if (ir.action === 'appeal') {
      const notOwner = actions.ownerRefusal(req, 'appeal');
      if (notOwner) return notOwner;
      const c = (opts.actionRegistry?.contracts ?? CONTRACTS).appeal;
      return json(409, { error: 'VARIANT_NOT_AVAILABLE', detail: `Not available: ${c.status === 'not_available' ? (c.reason ?? 'Contract not recorded yet') : 'not implemented yet'}` });
    }
    // Caps before any expensive work (PayPal read, composing, hashing); nothing changes when refused.
    const full = intents.admit(caseId, who.actor, who.client ?? 'local');
    if (full) return tooMany(full);
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
    if ('ok' in intent) return tooMany(intent);
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
    // An owner-only action is approved by the workspace owner only (the session's own intent first: anyone else's is 404).
    const mine = intents.get(intentId, who.actor);
    const action = mine && mine.caseId === caseId ? intentAction(mine) : null;
    if (action && action !== 'provide_evidence') {
      const notOwner = actions.ownerRefusal(req, action);
      if (notOwner) return notOwner;
    }
    const t = intents.approve(intentId, caseId, hash, who.actor);
    if (!t.ok) return json(t.status, { error: t.error, detail: t.detail, ...(t.intent ? { intent: publicIntent(t.intent) } : {}) });
    // An action's answer carries the terms of its second confirmation (null when it needs none); evidence's as before.
    if (action && action !== 'provide_evidence') return json(200, { ...publicIntent(t.intent), confirmation: actions.termsOf(t.intent) });
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
    // This route sends evidence: an action intent is refused before anything is reserved, claimed or invalidated.
    if (isActionRequest(i0.request) || intentAction(i0) !== 'provide_evidence' || i0.request.action === 'appeal') {
      return json(409, { error: 'WRONG_SEND_ROUTE', detail: 'This intent is not an evidence response; send it from its action' });
    }
    const evidenceRequest = i0.request;
    if (i0.disputeId !== boundId) {
      intents.invalidate(intentId, 'the case is bound to another dispute now');
      return json(409, { error: 'BINDING_CHANGED', detail: `This intent was composed for ${i0.disputeId ?? 'the simulator'}; the case is bound to ${boundId} now` });
    }

    // Evidence this server already sent, in any stage, blocks the whole dispute (evidence once: controller ruling,
    // Task 10), refused before anything is reserved, where beginSend refused it before stages (after its own checks).
    const sentHere = intents.sentFor(boundId);
    if (sentHere && sentHere.intentId !== intentId && (i0.status === 'approved' || i0.status === 'failed') && !intents.isUncertain(boundId)) {
      return json(409, { error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent', intent: publicIntent(i0) });
    }
    // One send at a time: of two concurrent confirmations, exactly one gets past this synchronous transition.
    const claim = intents.beginSend(intentId, caseId, who.actor);
    if (!claim.ok) return json(claim.status, { error: claim.error, detail: claim.detail, ...(claim.intent ? { intent: publicIntent(claim.intent) } : {}), ...(claim.holder ? { holder: claim.holder } : {}) });
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
      if (st.snap && sellerEvidenceBlocks(st.snap)) {
        return refuse(json(409, { error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent' }), 'PayPal already has seller evidence', true);
      }
      // This server's own memory of any evidence it sent on this dispute, in any stage (evidence once): PayPal's read
      // may lag behind an evidence submission it accepted. The stage just read is still logged with the send.
      const stage = st.snap?.stage ?? null;
      if (intents.sentFor(boundId)) {
        return refuse(json(409, { error: 'SELLER_EVIDENCE_EXISTS', detail: 'PayPal already has seller evidence for this dispute; nothing more can be sent' }), 'evidence already sent on this dispute', true);
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
      const again = await compose(caseId, st, evidenceRequest, intent.rechecks, intents.analysisPin(intent.analysisHash));
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
      const started = intents.recordChecked({ caseId, kind: 'send_started', actor: who.actor, disputeId: boundId, intentId, contentHash: intent.contentHash, requestId: intent.requestId, stage });
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
      if (!intents.sent(intentId, who.actor, 'accepted by PayPal (read back to confirm)', stage)) {
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
    // The notice names the case whose active binding or reserve lists the dispute (the reads and the audit trail below
    // stay with the active binding only).
    const noticeCase = caseId ?? caseListing(disputeId);
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
    notices.unshift({ eventId: e.id, eventType: e.event_type, disputeId, caseId: noticeCase, merchant, status: d.status ?? null, reason: d.reason ?? null, amount, at });
    if (notices.length > MAX_NOTICES) notices.length = MAX_NOTICES;
    if (caseId) {
      // One audit bucket per seller workspace, so one busy merchant cannot push another's history out.
      const team = merchant ? workspaceIdFor(merchant) : null;
      intents.record({ caseId, kind: 'paypal_notified', actor: 'PayPal (webhook)', owner: `PayPal (webhook) · ${team ?? 'unknown seller'}`, ...(team ? { team } : {}), disputeId, detail: `${e.event_type} · dispute ${disputeId} is ${d.status ?? 'without status'} at PayPal` });
    }
    log(`paypal webhook · ${e.id} · dispute ${disputeId} re-read · ${d.status ?? '?'}${caseId ? ` · case ${caseId}` : ' · not bound to a case'}`);
  };

  /** GET /api/paypal/notices: the viewer's own (hosted: the signed-in merchant's disputes; local: all). */
  /** The cases whose active binding or reserve lists this dispute (the first one: {@link caseListing}). */
  const casesListing = (disputeId: string): string[] =>
    Object.keys(opts.bindings).filter((k) => bindingOf(k)?.dispute === disputeId || (opts.reserve?.[k] ?? []).some((b) => b.dispute === disputeId));
  const caseListing = (disputeId: string): string | null => casesListing(disputeId)[0] ?? null;
  const noticesFor = (req: Request): Response => {
    const merchant = opts.gate ? (opts.gate.merchant?.(req) ?? null) : undefined;
    const mine = merchant === undefined ? notices : merchant ? notices.filter((n) => n.merchant === merchant) : [];
    // A notice about an owner-only case (the settlement case) is the owner's only, as the case itself: by the case it
    // names, and by its dispute, wherever the bindings list it now (active or reserve).
    const visible = mine.filter((n) => [n.caseId, ...casesListing(n.disputeId)].every((k) => !k || ownerSees(req, k)));
    return json(200, { notices: visible.map(({ merchant: _m, ...n }) => n) });
  };

  /** Merchant evidence uploads: the seller's workspace (local: the operator), the case's active dispute. */
  const uploadRoutes = createUploadRoutes({
    store: uploads,
    person: personOf,
    caseVisible,
    reserve: opts.gate ? (req) => opts.gate!.reserve(req, 'upload') : null,
    pdfJob: createPdfJob({ store: uploads, log, ...(opts.uploadStorageBytes ? { maxStorageBytes: opts.uploadStorageBytes } : {}) }),
    meterPages: opts.gate?.meterPages ? (req, pages) => opts.gate!.meterPages!(req, pages) : null,
    caseBinding: (caseId) => bindingOf(caseId)?.dispute ?? null,
    record: (e) => intents.record(e),
    // Deletion wins over reuse: an unsent intent attaching or quoting the upload is void; a send in flight is waited for.
    attachedTo: {
      sending: (id) => intents.usingUpload(id).some((i) => i.status === 'sending'),
      invalidate: (rec, actor) => {
        for (const i of intents.usingUpload(rec.id)) {
          if (i.status === 'sending') continue;
          const how = requestAttachments(i.request).includes(rec.id) ? 'it attaches' : 'it was composed with';
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

  /** The buying agent's runs: signed-in people (local: the operator); hosted, one daily and one per-person unit each. */
  const agentRoutes = createAgentRoutes({
    agent: opts.agent ?? null,
    person: personOf,
    reserve: opts.gate ? (req) => opts.gate!.reserve(req, 'agent-run') : null,
    log,
  });

  /** The dispute actions other than evidence (actions/routes.ts): compose, confirm, acknowledge, send, read back. */
  const actions = createActionRoutes({
    intents,
    caseState: (caseId, req) => caseState(caseId, req),
    sellerRefusal,
    actorOf,
    personOf,
    uploadsUnchanged,
    uploadFiles: async (caseId, st, ids) => {
      for (const id of ids) {
        if (!st.uploads.some((r) => r.id === id)) return json(422, { error: 'UNKNOWN_UPLOAD', detail: `Upload ${id} is not a confirmed upload of this case’s current dispute` });
      }
      return filesFor(caseId, st, [], ids);
    },
    recomposeEvidence: async (caseId, st, i) => {
      if (isActionRequest(i.request)) return json(409, { error: 'INTENT_STALE', detail: 'This intent is not composed from the analysis' });
      const again = await compose(caseId, st, i.request, i.rechecks, intents.analysisPin(i.analysisHash));
      return again instanceof Response ? again : { contentHash: again.contentHash, attachments: again.attachments };
    },
    reserve: opts.gate ? (req, action) => opts.gate!.reserve(req, action) : null,
    snapshotOf,
    paypal: opts.paypal,
    log,
    now,
    ...(opts.actionRegistry ? { contracts: opts.actionRegistry.contracts, rules: opts.actionRegistry.rules } : {}),
  });

  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/api/paypal/notices') return req.method === 'GET' ? noticesFor(req) : json(405, { error: 'METHOD_NOT_ALLOWED' });
    // Local mode has no demo lock; answering here keeps the web app's lock check from logging a 404.
    if (path === '/api/demo' && req.method === 'GET') return json(200, { hosted: false });
    if (path === '/api/health' && req.method === 'GET') {
      const h = await checkHealth();
      // Hosted: each real dispute is listed only to its own seller's workspace; everyone else runs them on the simulator.
      const live = await viewerLive(req);
      const candidates = h.paypal === 'unconfigured' || !live ? [] : Object.keys(opts.bindings).filter((k) => bindingOf(k));
      // Per case: only the cases whose seller is this workspace.
      const bound: string[] = [];
      for (const k of candidates) if (ownerSees(req, k) && (await sellerOfCase(req, k))) bound.push(k);
      // A store file that could not be read. Local: the stores' names. Hosted (public): only `true`, no names. The reason
      // and where it was kept: the operator's check and the log.
      const names = storageProblems().map((p) => p.store);
      const storage = names.length ? (opts.gate ? true : names) : null;
      return json(200, { ...h, bound, bindings: Object.fromEntries(bound.map((k) => [k, bindingState(k)])), ...(storage ? { storage } : {}) });
    }
    const a = /^\/api\/cases\/([A-Za-z0-9-]{1,64})\/analysis(\/progress|\/verify)?$/.exec(path);
    if (a) return analysisRoute(req, url, a[1]!, a[2] ?? '');
    const up = await uploadRoutes(req, url);
    if (up) return up;
    const ag = await agentRoutes(req, url);
    if (ag) return ag;
    const m = /^\/api\/disputes\/([A-Za-z0-9-]{1,64})(?:\/(evidence|send|intent|audit|hold)(?:\/(int-[0-9a-f]{32})(\/approve|\/cancel|\/confirm|\/acknowledge|\/readback)?)?)?$/.exec(path);
    if (!m) return json(404, { error: 'NOT_FOUND' });
    const caseId = m[1]!;
    const sub = m[2];
    const intentId = m[3];
    if (!(await caseVisible(req, caseId))) return json(404, { error: 'UNKNOWN_CASE' });

    // Intents and the audit log exist for every case: a simulated case's intent is approved here too, and the
    // in-browser simulator records it.
    if (sub === 'intent' || sub === 'audit') {
      if (!intentId && sub === 'intent') {
        if (req.method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
        // A simple action (message, accept, offer, escalate) is composed by the action routes; evidence and appeal here.
        const peek = (await req.clone().json().catch(() => null)) as { action?: unknown } | null;
        return peek && typeof peek === 'object' && isSimpleAction(peek.action) ? actions.compose(req, caseId) : createIntent(req, caseId);
      }
      if (m[4] === '/approve') return req.method === 'POST' ? approveIntent(req, caseId, intentId!) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      if (m[4] === '/confirm') return req.method === 'POST' ? actions.confirm(req, caseId, intentId!) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      if (m[4] === '/acknowledge') return req.method === 'POST' ? actions.acknowledge(req, caseId, intentId!) : json(405, { error: 'METHOD_NOT_ALLOWED' });
      // A read-back records what PayPal proves (it may release a held dispute): a POST, though it never POSTs to PayPal.
      if (m[4] === '/readback') return req.method === 'POST' ? actions.readBack(req, caseId, intentId!) : json(405, { error: 'METHOD_NOT_ALLOWED' });
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
    // The send holding the case's dispute (no PayPal read): a reloaded case page finds it and offers «Check again».
    if (sub === 'hold') return req.method === 'GET' ? actions.hold(req, caseId, bindingOf(caseId)?.dispute ?? null) : json(405, { error: 'METHOD_NOT_ALLOWED' });

    const disputeId = bindingOf(caseId)?.dispute;
    if (!disputeId) return json(404, { error: 'NOT_BOUND', detail: `Case ${caseId} is not bound to a PayPal dispute` });
    // Sending needs a signed-in person first (hosted). caseVisible already limited hosted to the seller's bound cases.
    if (sub === 'evidence' || sub === 'send') {
      const who = actorOf(req, true);
      if (!who.ok) return json(who.refusal.status, who.refusal.body);
    }
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
    if (sub === 'send' && req.method === 'POST') return actions.send(req, caseId, disputeId);
    return json(405, { error: 'METHOD_NOT_ALLOWED' });
  };

  return Object.assign(route, {
    inputFor: (caseId: string) => serverInput(caseId),
    sellerIds,
    sellerRead,
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
    opsReadBack: (intentId: string) => actions.opsReadBack(intentId),
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
        held: intents.holdOf(active.dispute),
      };
    }
    return { ...h, bindings, storage: storageProblems().map((p) => p.problem), holds: intents.allHolds() };
  }
}

/** The record of a stored intent, for tests. */
export type { StoredIntent };
