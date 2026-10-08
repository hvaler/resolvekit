import { useCallback, useMemo, useRef } from 'react';
import { Link, useMatch, useNavigate, useParams } from 'react-router-dom';
import { HighlightProvider } from '../app/highlight';
import { usePolling, useSecondsSince, useServices } from '../app/services';
import { useCaseDraft } from '../app/useCaseDraft';
import { AnalysisBar } from '../components/AnalysisBar';
import { AppBar } from '../components/AppBar';
import { ApproveFlow } from '../components/ApproveFlow';
import { CaseHeader } from '../components/CaseHeader';
import { ChecklistCard } from '../components/ChecklistCard';
import { ContradictionCard } from '../components/ContradictionCard';
import { EvidenceCard } from '../components/EvidenceCard';
import { ProcessingBanner } from '../components/ProcessingBanner';
import { ResponseComposer } from '../components/ResponseComposer';
import { Timeline } from '../components/Timeline';
import { buildSubmission } from '../domain/submission';
import { utcClock } from '../domain/time';
import type { ActionCode, CaseFile } from '../domain/types';
import { caseFiles, inbox, processingDispute } from '../fixtures';

export function ago(secs: number | null): string {
  if (secs == null) return 'not read yet';
  return secs < 60 ? `read ${secs}s ago` : `read ${Math.round(secs / 60)} min ago`;
}

export function CasePage() {
  const { id = '' } = useParams();
  const c = caseFiles[id];
  if (c) return <CaseFileScreen key={id} c={c} />;
  if (id === processingDispute.id) return <ProcessingScreen />;
  return <NotInDemo id={id} />;
}

function CaseFileScreen({ c }: { c: CaseFile }) {
  const id = c.summary.id;
  const { snapshots, addAudit } = useServices();
  usePolling([id]);
  const snap = snapshots[id];
  const navigate = useNavigate();
  const approveMatch = useMatch('/cases/:id/approve');
  const secs = useSecondsSince(snap?.checkedAt ?? null);

  const submitted = (snap?.evidences.length ?? 0) > 0;
  const allowed: readonly ActionCode[] = snap?.allowedActions ?? c.allowedActions;
  const status = snap?.status ?? c.summary.status;
  const onAudit = useCallback((who: string, what: string) => addAudit(id, who, what), [addAudit, id]);
  const d = useCaseDraft(c, { allowedActions: allowed, submitted, onAudit });

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
      <div className="relative flex h-screen min-w-[1180px] flex-col overflow-hidden" aria-hidden={showFlow || undefined}>
        <AppBar
          caseId={id}
          checkedAt={snap?.checkedAt ?? null}
          badge={
            c.kind === 'agent' ? <span className="rounded-sm bg-acc-soft px-[7px] py-[3px] text-[11.5px] font-medium text-acc">Agent purchase</span> : undefined
          }
        />
        <CaseHeader
          summary={c.summary}
          status={status}
          statusDetail={statusDetail}
          statusHighlight={submitted}
          wide={c.kind === 'agent'}
          className="border-b border-line"
        />
        <AnalysisBar steps={c.analysis.steps} run={d.run} note={c.analysis.note} onReplay={submitted ? undefined : d.replay} />
        <main className="flex min-h-0 flex-1">
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
                  onExplain={() => d.explain(cid)}
                  onResolve={(note) => d.resolve(cid, note)}
                />
              ) : null;
            }}
          />
          <section aria-label="Evidence" className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto px-5 pb-8 pt-4">
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
            {c.checklist && <ChecklistCard title={c.checklist.title} items={c.checklist.items} states={d.checklistStates} />}
            {c.evidence.map((e) => (
              <EvidenceCard
                key={e.id}
                evidence={e}
                used={d.used[e.id] ?? 0}
                contradictionOpen={!!e.contradictionId && d.contradictionsVisible && d.resolutionOf(e.contradictionId).status === 'open'}
              />
            ))}
          </section>
          <ResponseComposer
            c={c}
            d={d}
            allowedActions={allowed}
            checkedAt={snap?.checkedAt ?? null}
            submitted={submitted}
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
  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col">
      <AppBar caseId={s.id} checkedAt={snap?.checkedAt ?? null} />
      <main className="flex flex-col gap-2.5 px-7 pb-[30px] pt-6">
        <Link to="/" className="text-[12.5px]">
          ← All cases
        </Link>
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <CaseHeader
            summary={s}
            status={snap?.status ?? s.status}
            statusDetail={`${snap?.status ?? s.status} · ${s.statusReadAgo}`}
            statusHighlight
            processing
            className="border-b border-line"
          />
          <ProcessingBanner checkedAt={snap?.checkedAt ?? null} allowedActions={snap?.allowedActions ?? []} />
        </div>
      </main>
    </div>
  );
}

function NotInDemo({ id }: { id: string }) {
  const row = inbox.find((r) => r.id === id);
  const { snapshots } = useServices();
  return (
    <div className="flex min-h-screen flex-col">
      <AppBar caseId={id} checkedAt={snapshots[Object.keys(snapshots)[0] ?? '']?.checkedAt ?? null} />
      <main className="flex flex-col gap-3 px-7 py-6">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">{row ? row.reasonText : 'Case not found'}</h1>
        <p className="m-0 max-w-[640px] text-[14px] text-ink-2">
          {row
            ? `This dispute is listed in the inbox for illustration. Its case file is not part of the synthetic demo data yet.`
            : `There is no dispute ${id} in this workspace.`}
        </p>
        <Link to="/" className="text-body">
          ← All cases
        </Link>
      </main>
    </div>
  );
}
