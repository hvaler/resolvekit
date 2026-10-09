import { PENDING_STEPS, STAGES, toCitations } from '@resolvekit/analyst';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actionableBlockers, checklistState, citationUse, deriveSentences, draftBlockers, draftCounts, notesText, type Recheck } from '../domain/draft';
import { defaultEvidenceType, evidenceTypeOptions, selectEvidenceType } from '../domain/evidenceTypes';
import type { ActionCode, CaseFile, ContradictionResolution, EvidenceType } from '../domain/types';
import { replayStepMs, useRecording } from './recording';
import type { AnalysisHandle } from './useAnalysis';

/** Replays the analyst's steps one by one. `animate` false shows them done at once (a live run just finished). */
function useAnalysisReplay(stepCount: number, identity: string, animate: boolean) {
  const [run, setRun] = useState(animate ? 0 : stepCount);
  const [epoch, setEpoch] = useState(0);
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const lastEpoch = useRef(0);
  // Recording mode (demo video): slower steps, nothing else changes.
  const stepMs = replayStepMs(useRecording());
  useEffect(() => {
    const replayed = epoch !== lastEpoch.current;
    lastEpoch.current = epoch;
    if (!animateRef.current && !replayed) {
      setRun(stepCount);
      return;
    }
    setRun(0);
    const t = window.setInterval(() => {
      setRun((r) => {
        if (r >= stepCount) {
          window.clearInterval(t);
          return r;
        }
        return r + 1;
      });
    }, stepMs);
    return () => window.clearInterval(t);
  }, [stepCount, identity, epoch, stepMs]);
  return { run, replay: () => setEpoch((e) => e + 1) };
}

export interface CaseDraftOptions {
  /** Actions PayPal allows right now (from the latest read). */
  allowedActions: readonly ActionCode[];
  /** Evidence has been recorded by PayPal for this dispute. */
  submitted: boolean;
  onAudit: (who: string, what: string) => void;
  /** The real analysis behind `c` (see useAnalysis). */
  analysis: AnalysisHandle;
}

/** All the case-file and draft state for one dispute, with the rules from `domain/draft`. */
export function useCaseDraft(c: CaseFile, opts: CaseDraftOptions) {
  const an = opts.analysis.state;
  const ready = an.kind === 'ready';
  const identity = ready ? `${an.analysis.key}:${an.analysis.createdAt}` : an.kind;
  const { run: replayRun, replay: replayAnalysis } = useAnalysisReplay(c.analysis.steps.length, identity, !(ready && an.origin === 'live'));

  // While a live run is in progress the bar follows the server's stages; otherwise it replays the finished steps.
  const liveDone = an.kind === 'running' ? an.progress.filter((p) => p.stage !== 'ready').length : 0;
  const steps = ready
    ? c.analysis.steps
    : PENDING_STEPS.map((label, i) => (an.kind === 'running' ? (an.progress.find((p) => p.stage === STAGES[i])?.label ?? label) : label));
  const run = ready ? replayRun : liveDone;

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rechecks, setRechecks] = useState<Record<string, Recheck>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ContradictionResolution>>({});
  const [action, setAction] = useState<ActionCode>('provide_evidence');
  const options = useMemo(() => evidenceTypeOptions(c.summary.reason, c.requestedEvidenceType, c.evidenceTypes), [c]);
  const [evidenceType, setEvidenceType] = useState<EvidenceType | null>(() => defaultEvidenceType(options));
  const onAudit = opts.onAudit;
  const recheckSeq = useRef(0);

  const analysisComplete = ready && run >= c.analysis.steps.length;
  const contradictionsVisible = ready && run > c.analysis.contradictionStep;

  const views = useMemo(
    () => deriveSentences(c.sentences, { edits, rechecks, checking, analysisStep: run, rejectionStep: c.analysis.rejectionStep }),
    [c, edits, rechecks, checking, run],
  );

  const reset = useCallback(() => {
    recheckSeq.current++;
    setEdits({});
    setRechecks({});
    setEditing(null);
    setChecking(null);
    setResolutions({});
    setAction('provide_evidence');
    setEvidenceType(defaultEvidenceType(options));
  }, [options]);

  // A different analysis (re-run, other documents) has different sentences: start the draft over.
  const lastIdentity = useRef(identity);
  useEffect(() => {
    if (lastIdentity.current === identity) return;
    lastIdentity.current = identity;
    reset();
  }, [identity, reset]);

  const recheck = opts.analysis.recheck;
  const input = ready ? an.input : null;
  const saveEdit = useCallback(
    (id: string, text: string, why?: string) => {
      const t = text.trim();
      const s = c.sentences.find((x) => x.id === id);
      if (!t || !s) return;
      const num = c.sentences.indexOf(s) + 1;
      const seq = ++recheckSeq.current;
      setEdits((e) => ({ ...e, [id]: t }));
      setRechecks((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      setEditing(null);
      setChecking(id);
      onAudit('Alex Moreno', why ?? `Edited sentence ${num}`);
      // The edit is verified by the model on the server: citations chosen again, support judged from them.
      void recheck(t).then(
        (r) => {
          if (seq !== recheckSeq.current) return;
          const citations = input ? toCitations(input, r.citations) : s.citations;
          const label = r.verdict === 'supported' ? 'supported' : r.verdict === 'rejected' ? 'removed' : 'needs review';
          setRechecks((all) => ({ ...all, [id]: { state: r.verdict, reason: r.reason, note: `Edited · re-checked by ${r.model}: ${label}`, citations } }));
          setChecking(null);
          const ids = citations.map((x) => x.evidenceId).join(', ');
          onAudit('Analyst', `Re-checked sentence ${num} (${r.model}): ${label}${r.verdict === 'supported' && ids ? ` by ${ids}` : ''}`);
        },
        (e: unknown) => {
          if (seq !== recheckSeq.current) return;
          const why = e instanceof Error ? e.message : 'the re-check failed';
          setRechecks((all) => ({
            ...all,
            [id]: { state: 'needs_review', reason: `Why: this edit was not re-checked (${why}). Review it against the evidence yourself.`, note: 'Edited · not re-checked' },
          }));
          setChecking(null);
          onAudit('Analyst', `Could not re-check sentence ${num}: ${why}`);
        },
      );
    },
    [c, onAudit, recheck, input],
  );

  const explain = useCallback(
    (contradictionId: string) => {
      const k = c.contradictions.find((x) => x.id === contradictionId);
      if (!k || !k.explainSentenceId) return;
      const num = c.sentences.findIndex((x) => x.id === k.explainSentenceId) + 1;
      if (num === 0) return;
      setResolutions((r) => ({ ...r, [k.id]: { status: 'explained', sentenceNum: num } }));
      saveEdit(k.explainSentenceId, k.explainText, `Resolved ${k.blockerName.replace(/^the /, '')}: explained in sentence ${num}`);
    },
    [c, saveEdit],
  );

  const resolve = useCallback(
    (contradictionId: string, note: string) => {
      const k = c.contradictions.find((x) => x.id === contradictionId);
      setResolutions((r) => ({ ...r, [contradictionId]: { status: 'resolved', note, by: 'Alex Moreno' } }));
      onAudit('Alex Moreno', `Resolved ${k ? k.blockerName.replace(/^the /, '') : 'contradiction'} with a note: "${note}"`);
    },
    [c, onAudit],
  );

  const replay = useCallback(() => {
    reset();
    replayAnalysis();
  }, [reset, replayAnalysis]);

  const selected = options.find((o) => o.type === evidenceType) ?? null;
  const blockers = draftBlockers({
    sentences: views,
    contradictions: c.contradictions,
    resolutions,
    analysisComplete,
    ...(an.kind === 'unavailable' ? { analysisText: 'there is no analysis of these documents yet' } : {}),
    action,
    allowedActions: opts.allowedActions,
    evidenceType: selected ? { allowed: selected.allowed, satisfied: selected.satisfied, label: selected.label } : null,
    submitted: opts.submitted,
  });
  const actionable = actionableBlockers(blockers);
  const notes = notesText(views);

  return {
    run,
    steps,
    analysisComplete,
    analysisUnavailable: an.kind === 'unavailable' ? an.reason : null,
    contradictionsVisible,
    views,
    counts: draftCounts(views),
    used: citationUse(views),
    notes,
    edits,
    editing,
    setEditing,
    checking,
    saveEdit,
    resolutions,
    resolutionOf: (id: string): ContradictionResolution => resolutions[id] ?? { status: 'open' },
    explain,
    resolve,
    checklistStates: c.checklist ? c.checklist.items.map((i) => checklistState(i, resolutions)) : [],
    action,
    setAction,
    options,
    evidenceType,
    selectEvidenceType: (t: EvidenceType) => setEvidenceType((cur) => selectEvidenceType(options, cur, t)),
    blockers,
    actionable,
    ready: blockers.length === 0,
    replay,
  };
}

export type CaseDraft = ReturnType<typeof useCaseDraft>;
