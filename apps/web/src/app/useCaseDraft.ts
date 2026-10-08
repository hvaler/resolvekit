import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  actionableBlockers,
  checklistState,
  citationUse,
  deriveSentences,
  draftBlockers,
  draftCounts,
  notesText,
  recheckEdit,
} from '../domain/draft';
import { defaultEvidenceType, evidenceTypeOptions, selectEvidenceType } from '../domain/evidenceTypes';
import type { ActionCode, CaseFile, ContradictionResolution, EvidenceType } from '../domain/types';

const STEP_MS = 650;
const RECHECK_MS = 1200;

/** Replays the analyst's steps one by one, as in the design. */
function useAnalysisReplay(stepCount: number) {
  const [run, setRun] = useState(0);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    setRun(0);
    const t = window.setInterval(() => {
      setRun((r) => {
        if (r >= stepCount) {
          window.clearInterval(t);
          return r;
        }
        return r + 1;
      });
    }, STEP_MS);
    return () => window.clearInterval(t);
  }, [stepCount, epoch]);
  return { run, replay: () => setEpoch((e) => e + 1) };
}

export interface CaseDraftOptions {
  /** Actions PayPal allows right now (from the latest read). */
  allowedActions: readonly ActionCode[];
  /** Evidence has been recorded by PayPal for this dispute. */
  submitted: boolean;
  onAudit: (who: string, what: string) => void;
}

/** All the case-file and draft state for one dispute, with the rules from `domain/draft`. */
export function useCaseDraft(c: CaseFile, opts: CaseDraftOptions) {
  const { run, replay: replayAnalysis } = useAnalysisReplay(c.analysis.steps.length);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, ContradictionResolution>>({});
  const [action, setAction] = useState<ActionCode>('provide_evidence');
  const options = useMemo(() => evidenceTypeOptions(c.summary.reason, c.requestedEvidenceType, c.evidenceTypes), [c]);
  const [evidenceType, setEvidenceType] = useState<EvidenceType | null>(() => defaultEvidenceType(options));
  const timer = useRef<number | undefined>(undefined);
  const onAudit = opts.onAudit;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const analysisComplete = run >= c.analysis.steps.length;
  const contradictionsVisible = run > c.analysis.contradictionStep;

  const views = useMemo(
    () => deriveSentences(c.sentences, { edits, checking, analysisStep: run, rejectionStep: c.analysis.rejectionStep }),
    [c, edits, checking, run],
  );

  const saveEdit = useCallback(
    (id: string, text: string, why?: string) => {
      const t = text.trim();
      const s = c.sentences.find((x) => x.id === id);
      if (!t || !s) return;
      const num = c.sentences.indexOf(s) + 1;
      setEdits((e) => ({ ...e, [id]: t }));
      setEditing(null);
      setChecking(id);
      onAudit('Alex Moreno', why ?? `Edited sentence ${num}`);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setChecking(null);
        const r = recheckEdit(s, t);
        const ids = s.citations.map((x) => x.evidenceId).join(', ');
        onAudit('Analyst', `Re-checked sentence ${num}: ${r.state === 'supported' ? `supported${ids ? ` by ${ids}` : ''}` : r.state.replace('_', ' ')}`);
      }, RECHECK_MS);
    },
    [c, onAudit],
  );

  const explain = useCallback(
    (contradictionId: string) => {
      const k = c.contradictions.find((x) => x.id === contradictionId);
      if (!k) return;
      const num = c.sentences.findIndex((x) => x.id === k.explainSentenceId) + 1;
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
    window.clearTimeout(timer.current);
    setEdits({});
    setEditing(null);
    setChecking(null);
    setResolutions({});
    setAction('provide_evidence');
    setEvidenceType(defaultEvidenceType(options));
    replayAnalysis();
  }, [options, replayAnalysis]);

  const selected = options.find((o) => o.type === evidenceType) ?? null;
  const blockers = draftBlockers({
    sentences: views,
    contradictions: c.contradictions,
    resolutions,
    analysisComplete,
    action,
    allowedActions: opts.allowedActions,
    evidenceType: selected ? { allowed: selected.allowed, satisfied: selected.satisfied, label: selected.label } : null,
    submitted: opts.submitted,
  });
  const actionable = actionableBlockers(blockers);
  const notes = notesText(views);

  return {
    run,
    analysisComplete,
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
