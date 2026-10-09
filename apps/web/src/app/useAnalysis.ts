import { analysisKey, canonicalJson, type AnalysisInput, type CaseAnalysis, type Progress } from '@resolvekit/analyst';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnalysisRequestError, AnalysisUnreachableError, type AnalysisAnswer, type AnalysisClient, type AnalysisOrigin, type LiveState, type VerifyAnswer } from '../domain/analysisClient';
import { goldenAnalyses } from '../fixtures/golden';

const POLL_MS = 700;

/** Where the analysis on screen comes from: the server (golden, cache or a live run) or the golden copy in the app. */
export type ShownOrigin = AnalysisOrigin | 'bundled';

export type AnalysisState =
  /** The documents are not final yet (a bound case still reading PayPal). */
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'running'; progress: Progress[] }
  | { kind: 'ready'; analysis: CaseAnalysis; origin: ShownOrigin; input: AnalysisInput }
  | { kind: 'unavailable'; reason: string };

export interface AnalysisHandle {
  state: AnalysisState;
  /** Live-run budget on the server; null without a server. */
  live: LiveState | null;
  /** Why "Re-run with AI" is not possible right now (null when it is). */
  rerunBlocked: string | null;
  /** The last live re-run request failed (rate limit, model error); the shown analysis stays. */
  rerunError: string | null;
  rerun: () => void;
  /** Re-verify an edited sentence with the model (server). */
  recheck: (text: string) => Promise<VerifyAnswer>;
}

/** The input with the dispute's allowed actions blanked: what decides whether documents changed. */
const docsSignature = (i: AnalysisInput) => canonicalJson({ ...i, dispute: { ...i.dispute, allowedActions: [] } });

/**
 * The real analysis for a case: the server's stored one (cached live run or golden) or a live run with progress;
 * without a server, the golden analysis committed with the app when its key matches the documents shown.
 *
 * @param input the case's documents as shown, or null while they are not final.
 */
export function useAnalysis(caseId: string, input: AnalysisInput | null, client: AnalysisClient | null): AnalysisHandle {
  // Freeze the input per document set: allowed actions change after sending, the documents do not.
  const frozen = useRef<{ sig: string; input: AnalysisInput } | null>(null);
  if (input) {
    const sig = docsSignature(input);
    if (!frozen.current || frozen.current.sig !== sig) frozen.current = { sig, input };
  }
  const fixed = input ? frozen.current!.input : null;
  const sig = input ? frozen.current!.sig : null;

  const bundled = goldenAnalyses[caseId];
  const [state, setState] = useState<AnalysisState>(() =>
    // First paint: the bundled golden analysis, provisionally (its key is checked right after).
    fixed && bundled ? { kind: 'ready', analysis: bundled, origin: 'bundled', input: fixed } : fixed ? { kind: 'loading' } : { kind: 'waiting' },
  );
  const [live, setLive] = useState<LiveState | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean>(!!client);
  const run = useRef(0);

  const follow = useCallback(
    async (answer: AnalysisAnswer, myRun: number, inp: AnalysisInput) => {
      let a = answer;
      for (;;) {
        if (run.current !== myRun) return;
        if (a.live) setLive(a.live);
        if (a.status === 'ready') {
          setState({ kind: 'ready', analysis: a.analysis, origin: a.origin, input: inp });
          return;
        }
        if (a.status === 'failed') {
          setState({ kind: 'unavailable', reason: `The analysis failed: ${a.error}` });
          return;
        }
        setState({ kind: 'running', progress: a.progress });
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (run.current !== myRun || !client) return;
        a = await client.progress(caseId, a.key);
      }
    },
    [caseId, client],
  );

  const bundledFor = useCallback(
    async (inp: AnalysisInput): Promise<CaseAnalysis | null> => {
      if (!bundled) return null;
      const key = await analysisKey(inp, bundled.requestedModel, bundled.promptVersion);
      return key === bundled.key ? bundled : null;
    },
    [bundled],
  );

  const load = useCallback(
    async (inp: AnalysisInput, refresh: boolean) => {
      const myRun = ++run.current;
      const fallback = async (why: string) => {
        const g = await bundledFor(inp);
        if (run.current !== myRun) return;
        setState(g ? { kind: 'ready', analysis: g, origin: 'bundled', input: inp } : { kind: 'unavailable', reason: why });
      };
      if (!client) return fallback('No analysis for these documents: the analyst runs on the ResolveKit server, which is not connected');
      try {
        const a = await client.analyse(caseId, inp, refresh);
        setServerUp(true);
        await follow(a, myRun, inp);
      } catch (e) {
        if (run.current !== myRun) return;
        if (e instanceof AnalysisUnreachableError) {
          setServerUp(false);
          return fallback('No analysis for these documents: the ResolveKit server is not running');
        }
        const err = e instanceof AnalysisRequestError ? e : null;
        if (err?.live) setLive(err.live);
        const why = err ? err.message : 'The analysis could not be loaded';
        if (refresh) {
          // A refused re-run leaves the analysis on screen as it was.
          setRerunError(why);
          return load(inp, false);
        }
        return fallback(why);
      }
    },
    [caseId, client, follow, bundledFor],
  );

  useEffect(() => {
    if (!fixed) {
      setState({ kind: 'waiting' });
      return;
    }
    void (async () => {
      // Drop the provisional bundled analysis at once if it was not made from these documents.
      if (bundled && !(await bundledFor(fixed))) setState((s) => (s.kind === 'ready' && s.origin === 'bundled' ? { kind: 'loading' } : s));
      await load(fixed, false);
    })();
    return () => {
      run.current++;
    };
  }, [sig, load]);

  const rerun = useCallback(() => {
    if (!fixed) return;
    setRerunError(null);
    void load(fixed, true);
  }, [fixed, load]);

  const recheck = useCallback(
    async (text: string): Promise<VerifyAnswer> => {
      if (!client || !fixed) throw new Error('the AI verifier runs on the ResolveKit server, which is not connected');
      return client.verify(caseId, fixed, text);
    },
    [caseId, client, fixed],
  );

  let rerunBlocked: string | null = null;
  if (!client || !serverUp) rerunBlocked = 'Live runs need the ResolveKit server (npm run server) with a model key';
  else if (live && !live.configured) rerunBlocked = 'No model key (GEMINI_API_KEY / GROQ_API_KEY) on the server';
  else if (live && live.remaining <= 0) rerunBlocked = `Live-run limit reached (${live.limit}/hour); next in ${Math.ceil(live.resetInSec / 60)} min`;
  else if (state.kind === 'running' || state.kind === 'loading' || state.kind === 'waiting') rerunBlocked = 'Analysis in progress';

  return { state, live, rerunBlocked, rerunError, rerun, recheck };
}
