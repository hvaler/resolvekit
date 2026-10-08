import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SimulatedDisputeGateway, type DisputeGateway, type SimulatedOutcome } from '../domain/gateway';
import { utcHm } from '../domain/time';
import type { AuditEntry, DisputeSnapshot } from '../domain/types';
import { initialSnapshots } from '../fixtures';

export interface TrackedSnapshot extends DisputeSnapshot {
  /** Epoch ms of the last read from PayPal (via the gateway). */
  checkedAt: number;
}

interface Services {
  gateway: DisputeGateway;
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
    () => new SimulatedDisputeGateway(initialSnapshots, { outcome: () => outcomeRef.current, latencyMs }),
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

  const refresh = useCallback(
    async (id: string) => {
      try {
        applySnapshot(await gateway.getDispute(id));
      } catch {
        // A failed poll keeps the last known state; the sync indicator shows its age.
      }
    },
    [gateway, applySnapshot],
  );

  const addAudit = useCallback((id: string, who: string, what: string) => {
    setAudit((all) => ({ ...all, [id]: [...(all[id] ?? []), { time: utcHm(new Date()), who, what }] }));
  }, []);

  const value = useMemo<Services>(
    () => ({ gateway, outcome, setOutcome, snapshots, applySnapshot, refresh, audit, addAudit }),
    [gateway, outcome, snapshots, applySnapshot, refresh, audit, addAudit],
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
  const { refresh } = useServices();
  const key = disputeIds.join(',');
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    ids.forEach((id) => void refresh(id));
    const t = window.setInterval(() => ids.forEach((id) => void refresh(id)), POLL_MS);
    return () => window.clearInterval(t);
  }, [key, refresh]);
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
