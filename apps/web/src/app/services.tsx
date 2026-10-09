import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SimulatedDisputeGateway, type DisputeGateway, type SimulatedOutcome } from '../domain/gateway';
import { HttpDisputeGateway, RoutingDisputeGateway, modeFor, type GatewayMode, type ServerHealth } from '../domain/httpGateway';
import { utcHm } from '../domain/time';
import type { AuditEntry, DisputeSnapshot } from '../domain/types';
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
  /** Routes each case to real PayPal (bound case, server connected) or to the simulator. */
  gateway: DisputeGateway;
  /** The gateway serving this case right now. Capture it once per flow so a flow never switches mid-way. */
  gatewayFor: (caseId: string) => DisputeGateway;
  /** Which PayPal serves this case: shown in the app bar and in every "recorded" message. */
  modeOf: (caseId: string) => GatewayMode;
  /** The server's PayPal connection, once checked (null while checking). */
  health: ServerHealth | null;
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
}: {
  children: ReactNode;
  latencyMs?: number;
  /** The ResolveKit server. Pass null to run on the simulator only (tests). */
  server?: HttpDisputeGateway | null;
}) {
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
  const http = useMemo(() => (server === undefined ? new HttpDisputeGateway() : server), [server]);
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
  const inFlight = useRef(0);
  const refreshAll = useCallback(
    async (ids: readonly string[]) => {
      inFlight.current += 1;
      setSync((s) => (s.syncing ? s : { ...s, syncing: true }));
      const results = await Promise.allSettled(ids.map((id) => gateway.getDispute(id)));
      // A failed read keeps the last known state; the sync indicator says so and shows its age.
      let failed = false;
      for (const r of results) {
        if (r.status === 'fulfilled') applySnapshot(r.value);
        else failed = true;
      }
      inFlight.current -= 1;
      setSync({ syncing: inFlight.current > 0, failed, loaded: true });
    },
    [gateway, applySnapshot],
  );
  const refresh = useCallback((id: string) => refreshAll([id]), [refreshAll]);

  // Ask the server once whether PayPal is connected and which cases are bound; then read those cases from PayPal.
  useEffect(() => {
    if (!http) return;
    let live = true;
    void http.health().then((h) => {
      if (!live) return;
      healthRef.current = h;
      setHealth(h);
      if (h.bound.length) void refreshAll(h.bound);
    });
    return () => {
      live = false;
    };
  }, [http, refreshAll]);

  const addAudit = useCallback((id: string, who: string, what: string) => {
    setAudit((all) => ({ ...all, [id]: [...(all[id] ?? []), { time: utcHm(new Date()), who, what }] }));
  }, []);

  const value = useMemo<Services>(
    () => ({ gateway, gatewayFor, modeOf, health, simulator, sync, refreshAll, outcome, setOutcome, snapshots, applySnapshot, refresh, audit, addAudit }),
    [gateway, gatewayFor, modeOf, health, simulator, sync, refreshAll, outcome, snapshots, applySnapshot, refresh, audit, addAudit],
  );
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const v = useContext(ServicesContext);
  if (!v) throw new Error('useServices must be used inside ServicesProvider');
  return v;
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
