import { useEffect, useRef, useState } from 'react';
import {
  BARCODE_WARNING,
  FROM_COVER,
  HINT_LABEL,
  NO_TEXT_COPY,
  SELECTION_WARNING,
  afterCover,
  confirmPayload,
  includedPages,
  pageDraftOf,
  pageState,
  pdfBlocker,
  transcriptionArea,
  type PageDraft,
} from '../domain/pdfReview';
import { UploadRequestError, pageLabel, type Rect, type UploadRecordView, type UploadsClient } from '../domain/uploads';
import { ImageCover, LineEditor } from './UploadReview';
import { Button, Spinner, cx } from './ui';

export interface PdfReviewProps {
  /** A PDF whose pages are read (job `reviewing`), shown in full to a person who can edit it (never a restricted view). */
  upload: UploadRecordView;
  client: UploadsClient;
  /** The upload changed on the server (a page covered, confirmed, or discarded: null). */
  onChange: (u: UploadRecordView | null) => void;
  /** Back to the case; a pending upload stays pending. */
  onClose: () => void;
}

const message = (e: unknown) => (e instanceof UploadRequestError || e instanceof Error ? e.message : String(e));

/** A page's text hint as fetched (metered on the server, so only on request, once per page). */
type Hint = { state: 'loading' } | { state: 'ready'; lines: string[] } | { state: 'failed'; error: string };

/**
 * Review a PDF before it becomes evidence, page by page: cover what must not be shared on each page and have the
 * server read it again, correct what it misread, transcribe a line it missed (an area marked outside the covers, then
 * typed), then confirm the list of pages. Only the covered pages and their reviewed text are ever used.
 */
export function PdfReview({ upload, client, onChange, onClose }: PdfReviewProps) {
  const [rec, setRec] = useState(upload);
  const [drafts, setDrafts] = useState<PageDraft[]>(() => (upload.pdf?.pages ?? []).map(pageDraftOf));
  const [at, setAt] = useState(0);
  const [mode, setMode] = useState<'cover' | 'text'>('cover');
  const [view, setView] = useState<'original' | 'sanitised'>('original');
  const [busy, setBusy] = useState<null | 'redact' | 'confirm' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [hints, setHints] = useState<Record<number, Hint>>({});
  const [summary, setSummary] = useState(false);
  const [focusAdded, setFocusAdded] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const views = rec.pdf?.pages ?? [];
  const pages = views.map((v, i) => ({ view: v, draft: drafts[i]! }));
  const page = pages[at]!;
  const k = at + 1;
  const state = pageState(page.view, page.draft);
  const covered = state === 'covered';
  const blocker = pdfBlocker(pages);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const setDraft = (f: (d: PageDraft) => PageDraft) => setDrafts((all) => all.map((d, i) => (i === at ? f(d) : d)));
  const goTo = (i: number) => {
    setAt(i);
    setMode('cover');
    setView('original');
    setAreaError(null);
  };

  const act = async <T,>(what: 'redact' | 'confirm' | 'discard', f: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    try {
      return await f();
    } catch (e) {
      // The server's words as they are (a 422 transcription under a cover, a 409 page changed, a cover limit).
      setError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const coverPage = async () => {
    const i = at;
    const r = await act('redact', () => client.redactPage(rec.id, i + 1, drafts[i]!.rects));
    if (!r) return;
    const next = r.upload.pdf?.pages?.[i];
    setRec(r.upload);
    if (next) setDrafts((all) => all.map((d, j) => (j === i ? afterCover(d, next) : d)));
    setView('sanitised');
    onChange(r.upload);
  };
  const confirm = async () => {
    const body = confirmPayload(pages);
    if (!body) return;
    const u = await act('confirm', () => client.confirmPdf(rec.id, body));
    if (u) onChange(u);
  };
  const discard = async () => {
    const u = await act('discard', () => client.discard(rec.id));
    if (u) onChange(null);
  };
  const loadHint = async (i: number) => {
    setHints((h) => ({ ...h, [i]: { state: 'loading' } }));
    try {
      const lines = await client.hint(rec.id, i + 1);
      setHints((h) => ({ ...h, [i]: { state: 'ready', lines } }));
    } catch (e) {
      setHints((h) => ({ ...h, [i]: { state: 'failed', error: message(e) } }));
    }
  };
  const addArea = (r: Rect) => {
    const res = transcriptionArea(r, page.draft.rects);
    if ('error' in res) return setAreaError(res.error);
    setAreaError(null);
    setFocusAdded(page.draft.added.length);
    setDraft((d) => ({ ...d, added: [...d.added, { area: res.area, text: '' }] }));
  };

  const hint = hints[at];
  const label = pageLabel(page.view.original);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-review-title"
        className="flex h-[min(830px,calc(100vh-68px))] w-[min(1200px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none"
      >
        <div className="flex flex-none items-center gap-5 border-b border-line px-[26px] py-4 max-md:px-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="pdf-review-title" ref={headingRef} tabIndex={-1} className="m-0 text-[18px] font-semibold tracking-[-0.01em] outline-none">
              Review new evidence
            </h2>
            <span className="truncate font-mono text-caption leading-[1.3] text-ink-3">
              {rec.name} · PDF · {views.length} page{views.length === 1 ? '' : 's'} chosen · uploaded by {rec.uploadedBy.name}
            </span>
          </div>
          <span className="flex-1" />
          <button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="h-7 w-7 rounded-lg border border-line-2 bg-surface text-ink-2">
            ×
          </button>
        </div>

        {summary ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-[26px] pb-6 pt-5 max-md:px-4">
            <h3 className="m-0 text-[14px] font-semibold">These pages become evidence</h3>
            <ul aria-label="Pages included" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {includedPages(pages).map((t, i) => (
                <li key={i} className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
                  {t}
                </li>
              ))}
            </ul>
            <p role="note" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
              {SELECTION_WARNING}
            </p>
            <p className="m-0 text-[12.5px] text-ink-2">Only the covered pages and the text above are stored and used; the original PDF is deleted.</p>
            {error && (
              <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft px-3 py-2 text-body">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] max-md:block max-md:overflow-auto">
            <div className="flex flex-col gap-3 overflow-auto border-r border-line px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:border-r-0 max-md:px-4">
              <nav aria-label="Pages" className="flex flex-wrap gap-1.5">
                {pages.map((p, i) => {
                  const s = pageState(p.view, p.draft);
                  return (
                    <button
                      key={p.view.original}
                      type="button"
                      aria-current={i === at ? 'page' : undefined}
                      disabled={!!busy}
                      onClick={() => goTo(i)}
                      className={cx('rounded-md border px-2 py-0.5 text-[12px]', i === at ? 'border-acc bg-acc-soft text-acc' : 'border-line-2 bg-surface text-ink-2')}
                    >
                      Page {p.view.original} {s === 'covered' ? '✓' : s === 'stale' ? '· changed' : '· not covered'}
                    </button>
                  );
                })}
              </nav>
              <h3 className="m-0 text-[15px] font-semibold">{label}</h3>
              <p role="note" className="m-0 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-[12.5px] text-info">
                {BARCODE_WARNING}
              </p>
              <div role="group" aria-label="Drawing" className="flex gap-1.5">
                <button type="button" aria-pressed={mode === 'cover'} disabled={!!busy} onClick={() => setMode('cover')} className={cx('rounded-md border px-2 py-0.5 text-[12px]', mode === 'cover' ? 'border-acc bg-acc-soft text-acc' : 'border-line-2 bg-surface text-ink-2')}>
                  Cover
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'text'}
                  disabled={!!busy || !covered}
                  title={covered ? undefined : 'Cover this page first'}
                  onClick={() => {
                    setMode('text');
                    setView('original');
                  }}
                  className={cx('rounded-md border px-2 py-0.5 text-[12px] disabled:cursor-not-allowed disabled:opacity-50', mode === 'text' ? 'border-acc bg-acc-soft text-acc' : 'border-line-2 bg-surface text-ink-2')}
                >
                  Add text
                </button>
              </div>
              <ImageCover
                key={k}
                src={(v) => (v === 'original' ? client.pageUrl(rec.id, k, 'original') : client.pageUrl(rec.id, k, 'sanitised', page.view.sha256 ?? ''))}
                alt={`${rec.name}, ${label}`}
                noun="page"
                reviewed={!!page.view.sha256}
                rects={page.draft.rects}
                setRects={(f) => setDraft((d) => ({ ...d, rects: f(d.rects) }))}
                view={page.view.sha256 ? view : 'original'}
                setView={setView}
                disabled={!!busy}
                onTextArea={mode === 'text' && covered ? addArea : undefined}
                textAreas={page.draft.added.map((a) => a.area)}
              />
              {areaError && (
                <p role="alert" className="m-0 rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
                  {areaError}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3 overflow-auto bg-surface-2 px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:px-4">
              <div className="flex flex-col gap-1">
                <h4 className="m-0 text-[14px] font-semibold">{covered ? 'Text read from the covered page' : 'Text read from the original page'}</h4>
                <p className="m-0 text-[12.5px] text-ink-2">
                  {state === 'covered'
                    ? 'This is what the analyst will read. Correct a line where the reading is wrong; each correction is marked with who made it.'
                    : state === 'stale'
                      ? 'You changed what is covered: cover this page again before confirming.'
                      : 'Nothing is used yet. Drag over what must not be shared on this page, then cover it and have it read again, even if nothing needs covering.'}
                </p>
              </div>
              {page.view.readLines.length === 0 && (
                <p role="note" data-testid="no-text" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                  {NO_TEXT_COPY}
                </p>
              )}
              {covered ? (
                page.view.readLines.length > 0 && (
                  <LineEditor
                    lines={page.draft.lines}
                    read={page.view.readLines}
                    setLines={(f) => setDraft((d) => ({ ...d, lines: f(d.lines) }))}
                    disabled={!!busy}
                    empty=""
                    label={`Lines read on ${label}`}
                  />
                )
              ) : (
                page.view.readLines.length > 0 && (
                  <div className="flex flex-col rounded-lg border border-line bg-surface py-[5px]">
                    {page.view.readLines.map((l, i) => (
                      <span key={i} className="px-2.5 py-[3px] font-mono text-mono-frag text-ink-2">
                        {l || ' '}
                      </span>
                    ))}
                  </div>
                )
              )}

              {covered && (
                <div className="flex flex-col gap-1.5">
                  <h4 className="m-0 text-[13px] font-semibold">Lines you transcribe</h4>
                  <p className="m-0 text-[12px] text-ink-2">
                    A line the reading missed: choose Add text, drag over it on the page (never over a cover), then type it. It is marked as transcribed manually by you.
                  </p>
                  {page.draft.added.length > 0 && (
                    <ol aria-label={`Transcribed lines on ${label}`} className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {page.draft.added.map((a, i) => {
                        const under = 'error' in transcriptionArea(a.area, page.view.rects);
                        return (
                          <li key={`${a.area.x}-${a.area.y}-${i}`} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="w-6 flex-none text-right font-mono text-[11px] text-acc">{i + 1}</span>
                              <input
                                aria-label={`Transcribed line ${i + 1}`}
                                value={a.text}
                                autoFocus={focusAdded === i}
                                disabled={!!busy}
                                placeholder="Type the line as it is on the page"
                                onChange={(e) => {
                                  const text = e.target.value.replace(/[\r\n]/g, ' ');
                                  setDraft((d) => ({ ...d, added: d.added.map((x, j) => (j === i ? { ...x, text } : x)) }));
                                }}
                                className={cx('min-w-0 flex-1 rounded-md border bg-surface px-2 py-1 font-mono text-mono-frag', under ? 'border-bad-line' : 'border-acc-line')}
                              />
                              <button
                                type="button"
                                disabled={!!busy}
                                onClick={() => setDraft((d) => ({ ...d, added: d.added.filter((_, j) => j !== i) }))}
                                className="border-0 bg-transparent p-0 text-[12px] text-ink-2 underline"
                              >
                                Remove
                              </button>
                            </div>
                            {under && <span className="pl-8 text-[11.5px] text-bad">{FROM_COVER}</span>}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              )}

              <section aria-label={HINT_LABEL} className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line-2 px-3 py-2">
                <h4 className="m-0 text-[12.5px] font-semibold text-ink-2">{HINT_LABEL}</h4>
                {!hint || hint.state === 'failed' ? (
                  <>
                    {hint?.state === 'failed' && (
                      <span role="alert" className="text-[12px] text-bad">
                        {hint.error}
                      </span>
                    )}
                    <button type="button" disabled={!!busy} onClick={() => void loadHint(at)} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
                      {hint ? 'Try again' : 'Show it for this page'}
                    </button>
                  </>
                ) : hint.state === 'loading' ? (
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
                    <Spinner size={13} /> Reading…
                  </span>
                ) : hint.lines.length ? (
                  <div data-testid="pdf-hint" className="flex flex-col">
                    {hint.lines.map((l, i) => (
                      <span key={i} className="font-mono text-mono-frag text-ink-3">
                        {l || ' '}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-[12px] text-ink-3">This page has no text in the PDF.</span>
                )}
              </section>

              {error && (
                <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft px-3 py-2 text-body">
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex flex-none items-center gap-3 border-t border-line px-[26px] py-3.5 max-md:flex-wrap max-md:px-4">
          <Button onClick={() => void discard()} disabled={!!busy}>
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </Button>
          <Button onClick={summary ? () => setSummary(false) : onClose} disabled={!!busy}>
            {summary ? '← Back to the pages' : '← Back to case'}
          </Button>
          <span className="flex-1" />
          {!summary && blocker && <span className="text-[12px] text-ink-3 max-md:w-full">{blocker}</span>}
          {summary ? (
            <Button variant="primary" onClick={() => void confirm()} disabled={!!busy || !!blocker}>
              {busy === 'confirm' ? 'Confirming…' : 'Confirm as evidence'}
            </Button>
          ) : (
            <>
              <Button onClick={() => void coverPage()} disabled={!!busy || covered}>
                {busy === 'redact' ? (
                  <span className="flex items-center gap-2">
                    <Spinner size={14} /> Reading…
                  </span>
                ) : (
                  'Cover this page and read it again'
                )}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setError(null);
                  setSummary(true);
                }}
                disabled={!!busy || !!blocker}
              >
                Review the pages included
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
