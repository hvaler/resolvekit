import { buildInput, withAnalysis } from '@resolvekit/analyst';
import { caseView, documentsFinal } from '@resolvekit/cases';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useMatch, useNavigate, useParams } from 'react-router-dom';
import { HighlightProvider } from '../app/highlight';
import { DEMO_UPLOAD_REASON } from '../domain/copy';
import { usePayPalSource, usePolling, useSecondsSince, useServices } from '../app/services';
import { casesBase, draftScope } from '../domain/environment';
import { useAnalysis } from '../app/useAnalysis';
import { useCaseDraft } from '../app/useCaseDraft';
import { useUploads } from '../app/useUploads';
import { AddEvidencePanel, PendingUploads } from '../components/AddEvidence';
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
import { UploadReview } from '../components/UploadReview';
import { MiniButton } from '../components/ui';
import { actorName, lockedReason } from '../domain/demoClient';
import { caseAllowedActions, caseHeaderView } from '../domain/paypalView';
import { hasSellerEvidence, payPalEvents } from '../domain/recorded';
import { buildSubmission } from '../domain/submission';
import { utcClock } from '../domain/time';
import type { ActionCode, CaseFile } from '../domain/types';
import { approvalRequest, canEditUpload, confirmedUploads, evidenceCount, uploadsForInput, createUploadsClient, notAnalysed, uploadCorrections, uploadEvidence, withUploadDocuments, type UploadRecordView } from '../domain/uploads';
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
  const { snapshots, addAudit, analysis: analysisClient, demo: demoLock, area } = useServices();
  usePolling([id]);
  const source = usePayPalSource(id);
  // A bound case only uses a snapshot read from PayPal; a simulated one uses the simulator's.
  const snap = source.kind === 'live' || source.kind === 'simulated' ? snapshots[id] : undefined;
  const navigate = useNavigate();
  const base = casesBase(area);
  const approveMatch = useMatch(`${base}/:id/approve`);
  const secs = useSecondsSince(snap?.checkedAt ?? null);
  // PayPal's fields (amount, reason, status, requested evidence…) from PayPal for a bound case; demo data otherwise.
  const liveSnap = source.kind === 'live' ? source.snap : null;
  // `source` is rebuilt every render; its kind and PayPal snapshot are what matter.
  // The agent case's mandate/receipt/settlement from the real MeterMCP session when the server found one. The same
  // assembly (@resolvekit/cases) builds the analyst's input on the server.
  const caseDocs = useMemo(() => caseView(demo, source), [demo, source.kind, liveSnap]);
  // This workspace's uploads of the case (server only): confirmed ones are evidence after the case's own documents.
  const uploadsClient = useMemo(() => (area !== 'demo' && analysisClient ? createUploadsClient(id) : null), [area, analysisClient, id]);
  // Reloaded when the person or workspace changes (signing in after the page loaded).
  const up = useUploads(uploadsClient, `${demoLock?.person?.id ?? ''}:${demoLock?.workspace?.id ?? ''}`);
  // Signed out or another workspace: no uploads can be theirs, so their analysis never waits for the list.
  const canHaveUploads = !lockedReason(demoLock, 'upload');
  const inputUploads = uploadsForInput(up, canHaveUploads);
  const confirmedUps = useMemo(() => confirmedUploads(up.uploads), [up.uploads]);
  const pendingUps = up.uploads.filter((u) => u.status !== 'confirmed');
  const corrections = useMemo(() => uploadCorrections(up.uploads), [up.uploads]);
  const docs = useMemo(() => (confirmedUps.length ? { ...caseDocs, evidence: [...caseDocs.evidence, ...confirmedUps.map(uploadEvidence)] } : caseDocs), [caseDocs, confirmedUps]);

  const submitted = !!snap && hasSellerEvidence(snap);
  const allowed: readonly ActionCode[] = caseAllowedActions(source, snapshots[id], demo.allowedActions);

  // The analyst reads the documents exactly as shown: once PayPal's (and MeterMCP's) data is in for a bound case.
  const docsFinal = documentsFinal(source);
  // The uploads' documents exactly as the server adds them (after the list is known, so the input is built once).
  const input = useMemo(
    () => (docsFinal && inputUploads ? withUploadDocuments(buildInput(caseDocs, { allowedActions: allowed }), inputUploads) : null),
    [docsFinal, caseDocs, allowed.join(','), inputUploads],
  );
  const locked = useMemo(() => ({ live: lockedReason(demoLock, 'live-analysis'), recheck: lockedReason(demoLock, 'recheck') }), [demoLock]);
  // The server's reason when this person cannot add evidence here (signed out, another workspace).
  const uploadRefused = area === 'demo' ? DEMO_UPLOAD_REASON : (lockedReason(demoLock, 'upload') ?? up.refused);
  const uploadLocked = uploadRefused ?? (uploadsClient ? null : 'Adding evidence needs the ResolveKit server (npm run server)');
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
  const d = useCaseDraft(c, { allowedActions: allowed, submitted, onAudit, actor: actorName(demoLock), scope: draftScope(area, demoLock?.person?.id ?? null), analysis, corrections });
  // Confirmed evidence no analysis on screen has read yet: said so, never shown as if it were included.
  const unread = notAnalysed(up.uploads, an.kind === 'ready' ? an.input : null);

  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<{ upload: UploadRecordView; readLines: string[] } | null>(null);
  /** Pasted texts of this page's uploads (removals are offsets into them); never stored. */
  const pasted = useRef(new Map<string, string>());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadAction = async (f: () => Promise<void>) => {
    setUploadError(null);
    try {
      await f();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  };
  const discardUpload = (u: UploadRecordView) =>
    void uploadAction(async () => {
      await uploadsClient!.discard(u.id);
      up.put(u.id, null);
    });
  const deleteUpload = (u: UploadRecordView) => {
    if (!window.confirm(`Delete ${u.evidenceId} (${u.name})? The analyses that read it are deleted too.`)) return;
    void uploadAction(async () => {
      await uploadsClient!.remove(u.id);
      up.put(u.id, null);
    });
  };

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
                Evidence <span className="text-[12.5px] font-normal text-ink-3">· {evidenceCount(c.evidence)}</span>
              </h2>
              {c.kind === 'agent' ? (
                <span className="text-[12px] text-ink-3">Sources: PayPal, MeterMCP receipts</span>
              ) : (
                <button
                  type="button"
                  disabled={!!uploadLocked || submitted}
                  aria-expanded={adding}
                  onClick={() => setAdding((a) => !a)}
                  title={uploadLocked ?? (submitted ? 'Evidence was already submitted to PayPal' : undefined)}
                  className="rounded-md border border-line-2 bg-surface px-2.5 py-[5px] text-[12px] text-ink-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  + Add evidence
                </button>
              )}
            </div>
            {uploadRefused && c.kind !== 'agent' && (
              <p className="m-0 text-[12px] text-ink-3" data-testid="upload-locked">
                {uploadRefused}
              </p>
            )}
            {adding && uploadsClient && !uploadLocked && (
              <AddEvidencePanel
                client={uploadsClient}
                onClose={() => setAdding(false)}
                onAdded={(a, text) => {
                  if (text != null) pasted.current.set(a.upload.id, text);
                  up.put(a.upload.id, a.upload);
                  setAdding(false);
                  setReview({ upload: a.upload, readLines: a.readLines });
                }}
              />
            )}
            {unread.length > 0 && (
              <p role="status" data-testid="analysis-pending" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                Analysis pending: it does not include {unread.join(', ')} yet
                {an.kind === 'running' || an.kind === 'loading' ? ' · the analysis including it is running' : an.kind === 'unavailable' ? ` · ${an.reason}` : ''}. The draft is not based on{' '}
                {unread.length === 1 ? 'it' : 'them'}.
              </p>
            )}
            {uploadError && (
              <p role="alert" className="m-0 rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-[12.5px]">
                {uploadError}
              </p>
            )}
            {up.error && canHaveUploads && (
              <div role="alert" data-testid="uploads-error" className="flex flex-wrap items-center gap-2 rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1">
                  {up.known
                    ? `The uploads of this case could not be read (${up.error}); ${up.uploads.length ? 'the list below is the last one read' : 'none are shown'}. Trying again by itself.`
                    : `The uploads of this case could not be read (${up.error}). The analysis waits until they are: it would otherwise leave out confirmed evidence. Trying again by itself.`}
                </span>
                <MiniButton onClick={() => void up.reload()}>Retry</MiniButton>
              </div>
            )}
            <PendingUploads
              uploads={pendingUps}
              canEdit={(u) => canEditUpload(demoLock?.person, u)}
              onReview={(u) => setReview({ upload: u, readLines: u.readLines })}
              onDiscard={discardUpload}
            />
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
            {c.evidence.map((e) => {
              const u = confirmedUps.find((x) => x.evidenceId === e.id);
              return (
                <EvidenceCard
                  key={e.id}
                  evidence={e}
                  used={d.used[e.id] ?? 0}
                  contradictionOpen={!!e.contradictionId && d.contradictionsVisible && d.resolutionOf(e.contradictionId).status === 'open'}
                  contradictionLabel={contradictionLabel(c.contradictions.find((k) => k.id === e.contradictionId)?.blockerName)}
                  {...(u && !submitted && demoLock?.person?.reviewer !== true ? { actions: <MiniButton onClick={() => deleteUpload(u)}>Delete</MiniButton> } : {})}
                />
              );
            })}
          </section>
          <ResponseComposer
            c={c}
            d={d}
            allowedActions={allowed}
            realPayPal={snap?.origin?.kind === 'paypal'}
            checkedAt={snap?.checkedAt ?? null}
            submitted={submitted}
            {...(snap ? { snapshot: snap } : {})}
            onReview={() => navigate(`${base}/${id}/approve`)}
          />
        </main>
      </div>
      {showFlow && submission && (
        <ApproveFlow
          c={c}
          views={d.views}
          submission={submission}
          request={approvalRequest({ evidenceType: d.evidenceType!, edits: d.edits, resolutions: d.resolutions, views: d.views, corrections, confirmed: d.confirmedCorrections, attachments: [] })}
          uploads={confirmedUps}
          corrections={corrections}
          actionsBefore={actionsBefore.current}
          onClose={() => navigate(`${base}/${id}`)}
        />
      )}
      {review && uploadsClient && (
        <UploadReview
          key={review.upload.id}
          upload={review.upload}
          readLines={review.readLines}
          pastedText={pasted.current.get(review.upload.id) ?? null}
          client={uploadsClient}
          onChange={(u, readLines) => {
            const uid = review.upload.id;
            up.put(uid, u);
            if (!u || u.status === 'confirmed') {
              pasted.current.delete(uid);
              setReview(null);
            } else setReview({ upload: u, readLines: readLines ?? review.readLines });
          }}
          onClose={() => setReview(null)}
        />
      )}
    </HighlightProvider>
  );
}

function ProcessingScreen() {
  const s = processingDispute;
  const { snapshots, area } = useServices();
  usePolling([s.id]);
  const snap = snapshots[s.id];
  const status = snap?.status ?? s.status;
  const opened = status !== 'UNDER_REVIEW';
  return (
    <div className="flex min-h-screen min-w-[1180px] flex-col max-md:min-w-0">
      <AppBar caseId={s.id} checkedAt={snap?.checkedAt ?? null} />
      <main className="flex flex-col gap-2.5 px-7 pb-[30px] pt-6 max-md:px-4">
        <Link to={casesBase(area)} className="text-[12.5px]">
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
              PayPal has opened this dispute: {snap?.allowedActions.length ?? 0} actions are now allowed. This row shows the
              processing state only; its documents are not included in the demo.
            </p>
          ) : (
            <ProcessingBanner checkedAt={snap?.checkedAt ?? null} allowedActions={snap?.allowedActions ?? []} />
          )}
        </div>
      </main>
    </div>
  );
}

/** An id that is not a dispute of this area (every inbox row has a case file). */
function NotFound({ id }: { id: string }) {
  const { snapshots, area } = useServices();
  return (
    <div className="flex min-h-screen flex-col">
      <AppBar caseId={id} checkedAt={snapshots[Object.keys(snapshots)[0] ?? '']?.checkedAt ?? null} />
      <main className="flex flex-col gap-3 px-7 py-6 max-md:px-4">
        <h1 className="m-0 text-title-lg">Case not found</h1>
        <p className="m-0 max-w-[640px] text-[14px] text-ink-2">{`There is no dispute ${id} ${area === 'demo' ? 'in the demo' : 'in this workspace'}.`}</p>
        <Link to={casesBase(area)} className="text-body">
          ← All cases
        </Link>
      </main>
    </div>
  );
}
