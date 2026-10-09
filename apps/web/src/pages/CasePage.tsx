import { buildInput, withAnalysis } from '@resolvekit/analyst';
import { caseView, documentsFinal } from '@resolvekit/cases';
import { useCallback, useMemo, useRef } from 'react';
import { Link, useMatch, useNavigate, useParams } from 'react-router-dom';
import { HighlightProvider } from '../app/highlight';
import { usePayPalSource, usePolling, useSecondsSince, useServices } from '../app/services';
import { useAnalysis } from '../app/useAnalysis';
import { useCaseDraft } from '../app/useCaseDraft';
import { AnalysisBar, analysisLabel } from '../components/AnalysisBar';
import { AppBar } from '../components/AppBar';
import { ApproveFlow } from '../components/ApproveFlow';
import { CaseHeader } from '../components/CaseHeader';
import { ChecklistCard } from '../components/ChecklistCard';
import { ContradictionCard } from '../components/ContradictionCard';
import { EvidenceCard } from '../components/EvidenceCard';
import { ProcessingBanner } from '../components/ProcessingBanner';
import { ResponseComposer } from '../components/ResponseComposer';
import { Timeline } from '../components/Timeline';
import { lockedReason } from '../domain/demoClient';
import { caseAllowedActions, caseHeaderView } from '../domain/paypalView';
import { hasSellerEvidence, payPalEvents } from '../domain/recorded';
import { buildSubmission } from '../domain/submission';
import { utcClock } from '../domain/time';
import type { ActionCode, CaseFile } from '../domain/types';
import { caseFiles, processingDispute } from '../fixtures';

/** "the address contradiction" → "Address contradiction" (the badge on the documents involved). */
function contradictionLabel(blockerName: string | undefined): string {
  const t = (blockerName ?? 'contradiction').replace(/^the\s+/i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function ago(secs: number | null): string {
  if (secs == null) return 'not read yet';
  return secs < 60 ? `read ${secs}s ago` : `read ${Math.round(secs / 60)} min ago`;
}

export function CasePage() {
  const { id = '' } = useParams();
  const c = caseFiles[id];
  if (c) return <CaseFileScreen key={id} c={c} />;
  if (id === processingDispute.id) return <ProcessingScreen />;
  return <NotFound id={id} />;
}

function CaseFileScreen({ c: demo }: { c: CaseFile }) {
  const id = demo.summary.id;
  const { snapshots, addAudit, analysis: analysisClient, demo: demoLock } = useServices();
  usePolling([id]);
  const source = usePayPalSource(id);
  // A bound case only uses a snapshot read from PayPal; a simulated one uses the simulator's.
  const snap = source.kind === 'live' || source.kind === 'simulated' ? snapshots[id] : undefined;
  const navigate = useNavigate();
  const approveMatch = useMatch('/cases/:id/approve');
  const secs = useSecondsSince(snap?.checkedAt ?? null);
  // PayPal's fields (amount, reason, status, requested evidence…) from PayPal for a bound case; demo data otherwise.
  const liveSnap = source.kind === 'live' ? source.snap : null;
  // `source` is rebuilt every render; its kind and PayPal snapshot are what matter.
  // The agent case's mandate/receipt/settlement from the real MeterMCP session when the server found one. The same
  // assembly (@resolvekit/cases) builds the analyst's input on the server.
  const docs = useMemo(() => caseView(demo, source), [demo, source.kind, liveSnap]);

  const submitted = !!snap && hasSellerEvidence(snap);
  const allowed: readonly ActionCode[] = caseAllowedActions(source, snapshots[id], demo.allowedActions);

  // The analyst reads the documents exactly as shown: once PayPal's (and MeterMCP's) data is in for a bound case.
  const docsFinal = documentsFinal(source);
  const input = useMemo(() => (docsFinal ? buildInput(docs, { allowedActions: allowed }) : null), [docsFinal, docs, allowed.join(',')]);
  const locked = useMemo(() => ({ live: lockedReason(demoLock, 'live-analysis'), recheck: lockedReason(demoLock, 'recheck') }), [demoLock]);
  const analysis = useAnalysis(id, input, analysisClient, locked);
  const an = analysis.state;
  // A case that starts further on (evidence recorded, closed) also shows what happened at PayPal after the documents.
  const later = demo.simulatedPayPal && snap ? payPalEvents(snap, snap.origin?.kind === 'paypal' ? 'PayPal' : 'the simulator') : [];
  const c = useMemo(() => {
    if (an.kind !== 'ready') return docs;
    const withA = withAnalysis(docs, an.analysis, an.input);
    return later.length ? { ...withA, timeline: [...withA.timeline, ...later], timelineCaption: withA.timelineCaption.replace(/^(\d+) events/, (_, n: string) => `${Number(n) + later.length} events`) } : withA;
  }, [docs, an, later.length]);
  const status = snap?.status ?? demo.summary.status;
  const onAudit = useCallback((who: string, what: string) => addAudit(id, who, what), [addAudit, id]);
  const d = useCaseDraft(c, { allowedActions: allowed, submitted, onAudit, analysis });

  // Keep the approve flow open once started, even after the case becomes "submitted".
  const flowOpen = useRef(false);
  const actionsBefore = useRef<readonly ActionCode[]>(allowed);
  if (!approveMatch) flowOpen.current = false;
  else if (!flowOpen.current && d.ready) {
    flowOpen.current = true;
    actionsBefore.current = allowed;
  }
  const showFlow = !!approveMatch && flowOpen.current && d.evidenceType != null;

  const submission = useMemo(
    () => (d.evidenceType ? buildSubmission(c, d.views, d.evidenceType) : null),
    [c, d.views, d.evidenceType],
  );

  const statusDetail = submitted && snap ? `${status} · re-read ${utcClock(new Date(snap.checkedAt))}` : `${status} · ${ago(secs)}`;

  return (
    <HighlightProvider>
      <div
        className="relative flex h-screen min-w-[1180px] flex-col overflow-hidden max-md:h-auto max-md:min-h-screen max-md:min-w-0 max-md:overflow-visible"
        aria-hidden={showFlow || undefined}
      >
        <AppBar
          caseId={id}
          checkedAt={snap?.checkedAt ?? null}
          badge={
            c.kind === 'agent' ? <span className="rounded-sm bg-acc-soft px-[7px] py-[3px] text-[11.5px] font-medium text-acc">Agent purchase</span> : undefined
          }
        />
        <CaseHeader
          view={caseHeaderView({
            summary: demo.summary,
            source,
            simulatedStatus: status,
            statusDetail,
            now: new Date(),
            ...(source.kind === 'simulated' && snap ? { simulatedSnap: snap } : {}),
          })}
          statusHighlight={submitted}
          wide={c.kind === 'agent'}
          className="border-b border-line"
        />
        <AnalysisBar
          steps={d.steps}
          run={d.run}
          note={c.analysis.note}
          label={analysisLabel(an)}
          problem={d.analysisUnavailable ?? analysis.rerunError}
          onReplay={submitted || an.kind !== 'ready' ? undefined : d.replay}
          onRerun={submitted ? undefined : analysis.rerun}
          rerunBlocked={analysis.rerunBlocked}
          live={analysis.live}
        />
        <main className="flex min-h-0 flex-1 max-md:flex-col">
          <Timeline
            items={c.timeline}
            caption={c.timelineCaption}
            evidence={c.evidence}
            renderContradiction={(cid) => {
              const k = c.contradictions.find((x) => x.id === cid);
              return k ? (
                <ContradictionCard
                  contradiction={k}
                  resolution={d.resolutionOf(cid)}
                  visible={d.contradictionsVisible}
                  onExplain={k.explainSentenceId ? () => d.explain(cid) : undefined}
                  onResolve={(note) => d.resolve(cid, note)}
                />
              ) : null;
            }}
          />
          <section aria-label="Evidence" className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto px-5 pb-8 pt-4 max-md:overflow-visible max-md:px-4">
            <div className="flex items-baseline justify-between">
              <h2 className="m-0 text-[14px] font-semibold">
                Evidence <span className="text-[12.5px] font-normal text-ink-3">· {c.evidenceSources}</span>
              </h2>
              {c.kind === 'agent' ? (
                <span className="text-[12px] text-ink-3">Sources: PayPal, MeterMCP receipts</span>
              ) : (
                <button
                  type="button"
                  disabled
                  title="Uploading evidence is not available in this demo"
                  className="rounded-md border border-line-2 bg-surface px-2.5 py-[5px] text-[12px] text-ink-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  + Add evidence
                </button>
              )}
            </div>
            {c.notice && (
              <p
                role="note"
                className={
                  c.notice.tone === 'warn'
                    ? 'm-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn'
                    : 'm-0 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-[12.5px] text-info'
                }
              >
                {c.notice.text}
              </p>
            )}
            {c.checklist && <ChecklistCard title={c.checklist.title} items={c.checklist.items} states={d.checklistStates} />}
            {c.evidence.map((e) => (
              <EvidenceCard
                key={e.id}
                evidence={e}
                used={d.used[e.id] ?? 0}
                contradictionOpen={!!e.contradictionId && d.contradictionsVisible && d.resolutionOf(e.contradictionId).status === 'open'}
                contradictionLabel={contradictionLabel(c.contradictions.find((k) => k.id === e.contradictionId)?.blockerName)}
              />
            ))}
          </section>
          <ResponseComposer
            c={c}
            d={d}
            allowedActions={allowed}
            realPayPal={snap?.origin?.kind === 'paypal'}
            checkedAt={snap?.checkedAt ?? null}
            submitted={submitted}
            {...(snap ? { snapshot: snap } : {})}
            onReview={() => navigate(`/cases/${id}/approve`)}
          />
        </main>
      </div>
      {showFlow && submission && (
        <ApproveFlow c={c} views={d.views} submission={submission} actionsBefore={actionsBefore.current} onClose={() => navigate(`/cases/${id}`)} />
      )}
    </HighlightProvider>
  );
}

function ProcessingScreen() {
  const s = processingDispute;
  const { snapshots } = useServices();
  usePolling([s.id]);
  const snap = snapshots[s.id];
  const status = snap?.status ?? s.status;
  const opened = status !== 'UNDER_REVIEW';
  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col max-md:min-w-0">
      <AppBar caseId={s.id} checkedAt={snap?.checkedAt ?? null} />
      <main className="flex flex-col gap-2.5 px-7 pb-[30px] pt-6 max-md:px-4">
        <Link to="/" className="text-[12.5px]">
          ← All cases
        </Link>
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <CaseHeader
            view={caseHeaderView({
              summary: s,
              source: { kind: 'simulated' },
              simulatedStatus: status,
              statusDetail: `${status} · ${opened ? 'opened by PayPal' : s.statusReadAgo}`,
              now: new Date(),
            })}
            statusHighlight
            processing={!opened}
            className="border-b border-line"
          />
          {opened ? (
            <p role="status" className="m-0 bg-ok-soft px-[22px] py-3.5 text-body text-ink">
              PayPal has opened this dispute: {snap?.allowedActions.length ?? 0} actions are now allowed. Its case file is not part of the synthetic
              demo data yet.
            </p>
          ) : (
            <ProcessingBanner checkedAt={snap?.checkedAt ?? null} allowedActions={snap?.allowedActions ?? []} />
          )}
        </div>
      </main>
    </div>
  );
}

/** An id that is not a dispute of this workspace (every inbox row has a case file). */
function NotFound({ id }: { id: string }) {
  const { snapshots } = useServices();
  return (
    <div className="flex min-h-screen flex-col">
      <AppBar caseId={id} checkedAt={snapshots[Object.keys(snapshots)[0] ?? '']?.checkedAt ?? null} />
      <main className="flex flex-col gap-3 px-7 py-6 max-md:px-4">
        <h1 className="m-0 text-title-lg">Case not found</h1>
        <p className="m-0 max-w-[640px] text-[14px] text-ink-2">{`There is no dispute ${id} in this workspace.`}</p>
        <Link to="/" className="text-body">
          ← All cases
        </Link>
      </main>
    </div>
  );
}
