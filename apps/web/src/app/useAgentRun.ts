import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentRequestError, createAgentClient, type AgentClient, type RunScope } from '../domain/agentClient';
import { isLive, pollDelay, type AgentRun } from '../domain/agentRun';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The `/agent` page's state: the runs the caller can read (their own, or the workspace's when the owner asks for it),
 * the selected run read again at `pollDelay`'s pace until it and its settlement are final, and the actions (start,
 * stop, keep). `initialRun`: the run to select first (PayPal's return to `/agent?run=<id>`). `who` reloads the list
 * when someone signs in. `enabled`: false while the account is not known or nobody is signed in (nothing is asked).
 */
export function useAgentRun(o: { initialRun: string | null; who: string; enabled: boolean; client?: AgentClient }) {
  const enabled = o.enabled;
  const client = useMemo(() => o.client ?? createAgentClient(), [o.client]);
  const [scope, setScopeState] = useState<RunScope>('mine');
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [listKnown, setListKnown] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(o.initialRun);
  const [selected, setSelected] = useState<AgentRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | 'keep' | null>(null);

  /** Put a run read from the server in the list (it may be new) and in the selection. */
  const put = useCallback((run: AgentRun) => {
    setRuns((cur) => (cur.some((r) => r.id === run.id) ? cur.map((r) => (r.id === run.id ? run : r)) : [run, ...cur]));
    setSelected((cur) => (cur?.id === run.id ? run : cur));
  }, []);

  const reloadList = useCallback(async () => {
    try {
      setRuns(await client.list(scope));
      setListError(null);
    } catch (e) {
      setListError(message(e));
    } finally {
      setListKnown(true);
    }
  }, [client, scope]);

  useEffect(() => {
    if (enabled) void reloadList();
  }, [reloadList, o.who, enabled]);

  // The selected run: read now, then again at pollDelay's pace (backing off after failed reads) until it is final.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    // Another run (or none): what was shown belongs to the previous one, so no action can reach it.
    setSelected((cur) => (cur && cur.id === selectedId ? cur : null));
    if (!selectedId || !enabled) return;
    let cancelled = false;
    let last: AgentRun | null = null;
    let lastChange = Date.now();
    // Live: failed reads in a row. Settling (over, settlement not final): reads in a row without a change.
    let attempt = 0;
    const read = async () => {
      timer.current = null;
      let delay: number | null;
      try {
        const run = await client.get(selectedId, scope);
        if (cancelled) return;
        const changed = !last || last.updatedAt !== run.updatedAt;
        if (changed) lastChange = Date.now();
        attempt = isLive(run.state) || changed ? 0 : attempt + 1;
        last = run;
        put(run);
        setSelected(run);
        setRunError(null);
        delay = pollDelay(run, attempt, Date.now() - lastChange);
      } catch (e) {
        if (cancelled) return;
        // Not readable (404, signed out): nothing to poll. Anything else is retried with backoff.
        if (e instanceof AgentRequestError && (e.status === 404 || e.status === 401 || e.status === 403)) {
          setSelected(null);
          setRunError(e.message);
          return;
        }
        attempt++;
        setRunError(message(e));
        delay = pollDelay(last ?? { state: 'running', settlement: 'none' }, attempt, Date.now() - lastChange);
      }
      if (delay != null) timer.current = window.setTimeout(() => void read(), delay);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [client, selectedId, scope, put, enabled]);

  const select = useCallback((id: string | null) => {
    setRunError(null);
    setActionError(null);
    setSelected((cur) => (cur && cur.id === id ? cur : null));
    setSelectedId(id);
  }, []);

  /** Own runs or the workspace's; back to their own, an owner view of someone else's run is closed. */
  const setScope = useCallback(
    (s: RunScope) => {
      setScopeState(s);
      setListKnown(false);
      if (s === 'mine' && selected?.viewedAs === 'owner') setSelectedId(null);
    },
    [selected],
  );

  const act = useCallback(async <T,>(kind: 'start' | 'stop' | 'keep', f: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setActionError(null);
    try {
      return await f();
    } catch (e) {
      setActionError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const start = useCallback(
    async (input: { goal: string; cap: string; failFirst: string[] }) => {
      const run = await act('start', () => client.start(input));
      if (run) {
        put(run);
        setSelected(run);
        setSelectedId(run.id);
      }
      return run;
    },
    [act, client, put],
  );

  const stop = useCallback(
    async (run: AgentRun) => {
      const next = await act('stop', () => client.stop(run.id, run.viewedAs === 'owner' ? 'workspace' : 'mine'));
      if (next) put(next);
    },
    [act, client, put],
  );

  const keep = useCallback(
    async (run: AgentRun, kept: boolean) => {
      const r = await act('keep', () => client.keep(run.id, kept));
      // The answer is only the flag (keeping is no way to read someone else's run): set it on what is shown.
      if (r) put({ ...run, kept: r.kept });
    },
    [act, client, put],
  );

  return { scope, setScope, runs, listKnown, listError, reloadList, selectedId, selected, runError, select, actionError, busy, start, stop, keep };
}
