import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clientsFor } from './clients';
import { AnalysisClient } from '../domain/analysisClient';
import { DemoClient, type DemoState } from '../domain/demoClient';
import { SimulatedDisputeGateway, type DisputeGateway, type SimulatedOutcome } from '../domain/gateway';
import { HttpDisputeGateway, RoutingDisputeGateway, modeFor, type GatewayMode, type ServerHealth } from '../domain/httpGateway';
import { HttpIntentClient, LocalIntentClient, type IntentSource } from '../domain/intentClient';
import { payPalSource, type PayPalSource } from '../domain/paypalView';
import { utcHm } from '../domain/time';
import type { AuditEntry, DisputeSnapshot } from '../domain/types';
import { accountRecheckMs, draftScope, healthRetryDelay, type Area } from '../domain/environment';
import { clearKeptReviews, reviewsBelongTo } from '../domain/pdfReview';
import { initialSnapshots, processingDispute, processingOpening } from '../fixtures';

export interface TrackedSnapshot extends DisputeSnapshot {
  /** Epoch ms of the last read from PayPal (via the gateway). */
  checkedAt: number;
}

/** How the last read from PayPal went. */
export interface SyncState {
  /** A read is in flight (polling or "Sync now"). The data on screen stays usable. */
  syncing: boolean;
  /** The last read failed: what is shown is the saved data. */
  failed: boolean;
  /** At least one read has finished, so there is data to show. */
  loaded: boolean;
}

interface Services {
  /** The area on screen: the Explore demo (simulator and bundled analyses only) or the workspace. */
  area: Area;
  /** Submission intents: composed, approved and sent by the server (local composition only without a server). */
  intents: IntentSource;
  /** The AI analyst on the ResolveKit server; null when the app runs without a server (tests). */
  analysis: AnalysisClient | null;
  /** Routes each case to real PayPal (bound case, server connected) or to the simulator. */
  gateway: DisputeGateway;
  /** The gateway serving this case right now. Capture it once per flow so a flow never switches mid-way. */
  gatewayFor: (caseId: string) => DisputeGateway;
  /** Which PayPal serves this case: shown in the app bar and in every "recorded" message. */
  modeOf: (caseId: string) => GatewayMode;
  /** The server's PayPal connection, once checked (null while checking; `failed` while it cannot be read). */
  health: ServerHealth | null;
  /** Ask `/api/health` again now (a failed read is also retried on its own, with backoff). */
  retryHealth: () => void;
  /** Whether each case is real or simulated is known (the server answered, or there is no server). */
  modeKnown: boolean;
  /** Why the latest read of a case failed; cleared by the next successful read. */
  readErrors: Readonly<Record<string, string>>;
  /** The simulated PayPal behind {@link gateway}, for the demo controls. */
  simulator: SimulatedDisputeGateway;
  sync: SyncState;
  /** Read these disputes from PayPal now. */
  refreshAll: (disputeIds: readonly string[]) => Promise<void>;
  outcome: SimulatedOutcome;
  setOutcome: (o: SimulatedOutcome) => void;
  snapshots: Readonly<Record<string, TrackedSnapshot>>;
  applySnapshot: (s: DisputeSnapshot) => void;
  refresh: (disputeId: string) => Promise<void>;
  audit: Readonly<Record<string, AuditEntry[]>>;
  addAudit: (disputeId: string, who: string, what: string) => void;
  /** The hosted demo's account state (who is signed in, for which workspace); null without sign-in (local, no server). */
  demo: DemoState | null;
  /** Whether {@link demo} is known yet (the server answered, or there is no server). */
  accountKnown: boolean;
  /** Sign out of this browser, or of every device; the page reloads signed out. */
  signOut: (everywhere?: boolean, to?: string) => Promise<void>;
}

const ServicesContext = createContext<Services | null>(null);

export const POLL_MS = 30_000;
const SIMULATED_LATENCY_MS = 700;

function initialOutcome(): SimulatedOutcome {
  if (typeof window === 'undefined') return 'waiting_for_buyer';
  const q = new URLSearchParams(window.location.search).get('outcome');
  return q === 'under_review' || q === 'timeout' ? q : 'waiting_for_buyer';
}

export function ServicesProvider({
  children,
  latencyMs = SIMULATED_LATENCY_MS,
  server,
  area = 'workspace',
}: {
  children: ReactNode;
  latencyMs?: number;
  /** The ResolveKit server. Pass null to run on the simulator only (tests). */
  server?: HttpDisputeGateway | null;
  /** `demo`: simulator only, local intents, bundled golden analyses; the account still comes from the server. */
  area?: Area;
}) {
  const demoArea = area === 'demo';
  const [outcome, setOutcome] = useState<SimulatedOutcome>(initialOutcome);
  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;

  // One simulator for the whole session; bound cases go to the ResolveKit server (real PayPal) instead.
  const simulator = useMemo(
    () =>
      new SimulatedDisputeGateway(initialSnapshots, {
        outcome: () => outcomeRef.current,
        latencyMs,
        openings: { [processingDispute.id]: processingOpening },
      }),
    [latencyMs],
  );
  const kinds = clientsFor(area, server);
  const http = useMemo(() => (kinds.gateway === 'http' ? (server ?? new HttpDisputeGateway()) : null), [kinds.gateway, server]);
  const analysis = useMemo(() => (kinds.analysis ? new AnalysisClient() : null), [kinds.analysis]);
  const intents = useMemo<IntentSource>(() => (kinds.intents === 'http' ? new HttpIntentClient() : new LocalIntentClient()), [kinds.intents]);
  // The demo area is nested inside the workspace's provider and reuses its account state instead of asking again.
  const parent = useContext(ServicesContext);
  const inherit = demoArea && parent != null;
  const demoClient = useMemo(() => (server === null || inherit ? null : new DemoClient()), [server, inherit]);
  const [ownDemo, setDemo] = useState<DemoState | null>(null);
  const [ownKnown, setAccountKnown] = useState(server === null);
  const demo = inherit ? parent.demo : ownDemo;
  const accountKnown = inherit ? parent.accountKnown : ownKnown;
  useEffect(() => {
    if (!demoClient) return;
    let live = true;
    void demoClient.state().then((d) => {
      if (!live) return;
      setDemo(d);
      setAccountKnown(true);
    });
    return () => {
      live = false;
    };
  }, [demoClient]);
  // A PDF review kept in memory belongs to the person signed in: any change of account (sign-out, another person,
  // an expired session) drops the reviews kept for anyone else.
  const personId = demo?.person?.id ?? null;
  useEffect(() => {
    if (!inherit && accountKnown) reviewsBelongTo(draftScope('workspace', personId));
  }, [inherit, accountKnown, personId]);
  // The session expires on the server; follow it on screen.
  useEffect(() => {
    if (!demo?.signedIn || !demo.expiresAt || !demoClient) return;
    const ms = Date.parse(demo.expiresAt) - Date.now();
    const t = window.setTimeout(() => void demoClient.state().then(setDemo), Math.max(1_000, Math.min(ms + 1_000, 2_147_000_000)));
    return () => window.clearTimeout(t);
  }, [demo, demoClient]);
  // While the connection is being checked (the checking screen), read the account again until it is known. A failed
  // read (null) keeps what is on screen and is asked again on the next tick.
  const recheckMs = accountRecheckMs(demo);
  useEffect(() => {
    if (!recheckMs || !demoClient) return;
    const t = window.setInterval(() => void demoClient.state().then((d) => d && setDemo(d)), recheckMs);
    return () => window.clearInterval(t);
  }, [recheckMs, demoClient]);
  // Which disputes are live depends on who is signed in: signing out reloads the app from the server's view.
  const ownSignOut = useCallback(
    async (everywhere = false, to = '/') => {
      if (!demoClient) return;
      await demoClient.signOut(everywhere); // rejects when it fails: the caller says so and the person stays here
      clearKeptReviews();
      window.location.assign(to);
    },
    [demoClient],
  );
  const signOut = inherit ? parent.signOut : ownSignOut;
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const healthRef = useRef<ServerHealth | null>(null);
  healthRef.current = health;
  const modeOf = useCallback((caseId: string) => modeFor(caseId, healthRef.current), []);
  const gateway = useMemo<DisputeGateway>(() => (http ? new RoutingDisputeGateway(http, simulator, modeOf) : simulator), [http, simulator, modeOf]);
  const gatewayFor = useCallback((caseId: string): DisputeGateway => (http && modeOf(caseId).kind === 'paypal' ? http : simulator), [http, simulator, modeOf]);

  const [snapshots, setSnapshots] = useState<Record<string, TrackedSnapshot>>(() => {
    const now = Date.now();
    return Object.fromEntries(initialSnapshots.map((s) => [s.id, { ...s, checkedAt: now - 12_000 }]));
  });
  const [audit, setAudit] = useState<Record<string, AuditEntry[]>>({});

  const applySnapshot = useCallback((s: DisputeSnapshot) => {
    setSnapshots((all) => ({ ...all, [s.id]: { ...s, checkedAt: Date.now() } }));
  }, []);

  const [sync, setSync] = useState<SyncState>({ syncing: false, failed: false, loaded: false });
  const [readErrors, setReadErrors] = useState<Record<string, string>>({});
  const inFlight = useRef(0);
  const refreshAll = useCallback(
    async (ids: readonly string[]) => {
      inFlight.current += 1;
      setSync((s) => (s.syncing ? s : { ...s, syncing: true }));
      const results = await Promise.allSettled(ids.map((id) => gateway.getDispute(id)));
      // A failed read keeps the last known state; the sync indicator says so and shows its age.
      let failed = false;
      const errors: Record<string, string | null> = {};
      results.forEach((r, i) => {
        const id = ids[i]!;
        if (r.status === 'fulfilled') {
          // A simulator read that was in flight when the case turned out to be bound must not replace PayPal's data.
          if (modeOf(id).kind === 'paypal' && r.value.origin?.kind !== 'paypal') return;
          applySnapshot(r.value);
          errors[id] = null;
        } else {
          failed = true;
          errors[id] = r.reason instanceof Error ? r.reason.message : String(r.reason);
        }
      });
      setReadErrors((all) => {
        const next = { ...all };
        for (const [id, e] of Object.entries(errors)) {
          if (e == null) delete next[id];
          else next[id] = e;
        }
        return next;
      });
      inFlight.current -= 1;
      setSync({ syncing: inFlight.current > 0, failed, loaded: true });
    },
    [gateway, applySnapshot, modeOf],
  );
  const refresh = useCallback((id: string) => refreshAll([id]), [refreshAll]);

  // Ask the server whether PayPal is connected and which cases are bound; then read those cases from PayPal.
  const [healthTry, setHealthTry] = useState(0);
  const [healthFailures, setHealthFailures] = useState(0);
  useEffect(() => {
    if (!http) return;
    let live = true;
    void http.health().then((h) => {
      if (!live) return;
      healthRef.current = h;
      setHealth(h);
      setHealthFailures((n) => (h.failed ? n + 1 : 0));
      if (h.bound.length) void refreshAll(h.bound);
    });
    return () => {
      live = false;
    };
  }, [http, refreshAll, healthTry]);
  // A failed read is "unknown", not "nothing bound": hosted, ask again with backoff until the server answers.
  // Local mode (no account state) keeps its single read, as before.
  useEffect(() => {
    if (!healthFailures || !demo) return;
    const t = window.setTimeout(() => setHealthTry((n) => n + 1), healthRetryDelay(healthFailures));
    return () => window.clearTimeout(t);
  }, [healthFailures, demo]);
  const retryHealth = useCallback(() => setHealthTry((n) => n + 1), []);

  const addAudit = useCallback((id: string, who: string, what: string) => {
    setAudit((all) => ({ ...all, [id]: [...(all[id] ?? []), { time: utcHm(new Date()), who, what }] }));
  }, []);

  const modeKnown = !http || health != null;
  const value = useMemo<Services>(
    () => ({ area, intents, analysis, gateway, gatewayFor, modeOf, health, retryHealth, modeKnown, readErrors, simulator, sync, refreshAll, outcome, setOutcome, snapshots, applySnapshot, refresh, audit, addAudit, demo, accountKnown, signOut }),
    [area, intents, analysis, gateway, gatewayFor, modeOf, health, retryHealth, modeKnown, readErrors, simulator, sync, refreshAll, outcome, snapshots, applySnapshot, refresh, audit, addAudit, demo, accountKnown, signOut],
  );
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const v = useContext(ServicesContext);
  if (!v) throw new Error('useServices must be used inside ServicesProvider');
  return v;
}

/** Where this case's PayPal fields come from now: demo/simulator, or PayPal (reading, live, saved, unreachable). */
export function usePayPalSource(caseId: string): PayPalSource {
  const { modeOf, modeKnown, snapshots, readErrors } = useServices();
  return payPalSource(modeKnown ? modeOf(caseId) : null, snapshots[caseId], readErrors[caseId]);
}

/** Re-read the dispute from PayPal every 30 s while the page is open. */
export function usePolling(disputeIds: readonly string[]): void {
  const { refreshAll } = useServices();
  const key = disputeIds.join(',');
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (!ids.length) return;
    void refreshAll(ids);
    const t = window.setInterval(() => void refreshAll(ids), POLL_MS);
    return () => window.clearInterval(t);
  }, [key, refreshAll]);
}

/** Seconds elapsed since `since`, updated every second. */
export function useSecondsSince(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return since == null ? null : Math.max(0, Math.round((now - since) / 1000));
}
