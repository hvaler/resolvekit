import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SimulatedDisputeGateway, type DisputeGateway, type SimulatedOutcome } from '../domain/gateway';
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
  gateway: DisputeGateway;
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

export function ServicesProvider({ children, latencyMs = SIMULATED_LATENCY_MS }: { children: ReactNode; latencyMs?: number }) {
  const [outcome, setOutcome] = useState<SimulatedOutcome>(initialOutcome);
  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;

  // One gateway for the whole session. The real one will call a server route backed by packages/paypal.
  const gateway = useMemo(
    () =>
      new SimulatedDisputeGateway(initialSnapshots, {
        outcome: () => outcomeRef.current,
        latencyMs,
        openings: { [processingDispute.id]: processingOpening },
      }),
    [latencyMs],
  );

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

  const addAudit = useCallback((id: string, who: string, what: string) => {
    setAudit((all) => ({ ...all, [id]: [...(all[id] ?? []), { time: utcHm(new Date()), who, what }] }));
  }, []);

  const value = useMemo<Services>(
    () => ({ gateway, simulator: gateway, sync, refreshAll, outcome, setOutcome, snapshots, applySnapshot, refresh, audit, addAudit }),
    [gateway, sync, refreshAll, outcome, snapshots, applySnapshot, refresh, audit, addAudit],
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
