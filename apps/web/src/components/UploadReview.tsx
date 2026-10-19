import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { UploadRequestError, mergeRemoval, toImageRect, type Rect, type TextRemoval, type UploadRecordView, type UploadsClient } from '../domain/uploads';
import { Button, Spinner, cx } from './ui';

export interface UploadReviewProps {
  upload: UploadRecordView;
  /** The text read so far (from the upload, or from the last redaction). */
  readLines: string[];
  /** Pasted text as this browser pasted it (removals are offsets into it); null when this browser does not have it. */
  pastedText: string | null;
  client: UploadsClient;
  /** The upload changed on the server (redacted, confirmed, or discarded: null). */
  onChange: (u: UploadRecordView | null, readLines?: string[]) => void;
  /** Back to the case; a pending upload stays pending. */
  onClose: () => void;
}

const message = (e: unknown) => (e instanceof UploadRequestError || e instanceof Error ? e.message : String(e));
const same = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Review an upload before it becomes evidence: cover what must not be shared (rectangles on the image, or spans of
 * pasted text), have the server read the covered file again, correct what it misread, then confirm or discard. Only
 * the confirmed, covered file and its reviewed text are ever used; nothing leaves the server before that.
 */
export function UploadReview({ upload, readLines, pastedText, client, onChange, onClose }: UploadReviewProps) {
  const [rec, setRec] = useState(upload);
  const [read, setRead] = useState<string[]>(readLines);
  const [lines, setLines] = useState<string[]>(readLines);
  const [rects, setRects] = useState<Rect[]>(upload.rects ?? []);
  const [removals, setRemovals] = useState<TextRemoval[]>(upload.removals ?? []);
  const [busy, setBusy] = useState<null | 'redact' | 'confirm' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'original' | 'sanitised'>('original');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const reviewing = rec.status === 'reviewing';
  // Covers changed since the server last read the file: read it again before confirming.
  const stale = !reviewing || !same(rects, rec.rects ?? []) || !same(removals, rec.removals ?? []);
  const canConfirm = reviewing && !stale && !busy && !!rec.sha256 && lines.every((l) => !/[\r\n]/.test(l));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const act = async <T,>(what: 'redact' | 'confirm' | 'discard', f: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    try {
      return await f();
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const readAgain = async () => {
    const r = await act('redact', () => client.redact(rec.id, rec.kind === 'image' ? { rects } : { removals }));
    if (!r) return;
    setRec(r.upload);
    setRead(r.readLines);
    setLines(r.readLines);
    if (rec.kind === 'image') setView('sanitised');
    onChange(r.upload, r.readLines);
  };
  const confirm = async () => {
    if (!canConfirm) return;
    const u = await act('confirm', () => client.confirm(rec.id, lines, rec.sha256!));
    if (u) onChange(u);
  };
  const discard = async () => {
    const u = await act('discard', () => client.discard(rec.id));
    if (u) onChange(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--scrim)] px-6 pt-[34px] max-md:px-0 max-md:pt-0">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-review-title"
        className="flex h-[min(830px,calc(100vh-68px))] w-[min(1200px,100%)] flex-col overflow-hidden rounded-3xl bg-surface shadow-modal max-md:h-[100dvh] max-md:rounded-none"
      >
        <div className="flex flex-none items-center gap-5 border-b border-line px-[26px] py-4 max-md:px-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="upload-review-title" ref={headingRef} tabIndex={-1} className="m-0 text-[18px] font-semibold tracking-[-0.01em] outline-hidden">
              Review new evidence
            </h2>
            <span className="truncate font-mono text-caption leading-[1.3] text-ink-3">
              {rec.name} · {rec.kind === 'image' ? 'image' : 'pasted text'} · uploaded by {rec.uploadedBy.name} · {reviewing ? 'covered, read again' : 'not covered yet'}
            </span>
          </div>
          <span className="flex-1" />
          <button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="h-7 w-7 rounded-lg border border-line-2 bg-surface text-ink-2">
            ×
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] max-md:block max-md:overflow-auto">
          <div className="flex flex-col gap-3 overflow-auto border-r border-line px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:border-r-0 max-md:px-4">
            {rec.kind === 'image' ? (
              <ImageCover
                src={(v) => (v === 'original' ? client.imageUrl(rec.id, 'original') : client.imageUrl(rec.id, 'sanitised', rec.sha256 ?? ''))}
                alt={rec.name}
                noun="image"
                reviewed={reviewing}
                rects={rects}
                setRects={setRects}
                view={reviewing ? view : 'original'}
                setView={setView}
                disabled={!!busy}
              />
            ) : (
              <TextCover text={pastedText} removals={removals} setRemovals={setRemovals} disabled={!!busy} />
            )}
          </div>

          <div className="flex flex-col gap-3 overflow-auto bg-surface-2 px-[26px] pb-6 pt-5 max-md:overflow-visible max-md:px-4">
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-[14px] font-semibold">{reviewing ? 'Text read from the covered file' : 'Text read from the original'}</h3>
              <p className="m-0 text-[12.5px] text-ink-2">
                {reviewing
                  ? stale
                    ? 'You changed what is covered: read the file again before confirming.'
                    : 'This is what the analyst will read. Correct a line where the reading is wrong; each correction is marked with who made it.'
                  : `Nothing is used yet. ${rec.kind === 'image' ? 'Cover what must not be shared (account numbers, addresses…)' : 'Remove what must not be shared'}, then read it again, even if nothing needs covering.`}
              </p>
            </div>
            {reviewing ? (
              <LineEditor lines={lines} read={read} setLines={setLines} disabled={!!busy} empty="No text was read from the covered file." />
            ) : (
              <div className="flex flex-col rounded-lg border border-line bg-surface py-[5px]">
                {read.length ? (
                  read.map((l, i) => (
                    <span key={i} className="px-2.5 py-[3px] font-mono text-mono-frag text-ink-2">
                      {l || ' '}
                    </span>
                  ))
                ) : (
                  <span className="px-2.5 py-[3px] text-[12.5px] text-ink-3">The text is read again once you have covered what must not be shared.</span>
                )}
              </div>
            )}
            {error && (
              <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft px-3 py-2 text-body">
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-none items-center gap-3 border-t border-line px-[26px] py-3.5 max-md:flex-wrap max-md:px-4">
          <Button onClick={() => void discard()} disabled={!!busy}>
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </Button>
          <Button onClick={onClose} disabled={!!busy}>
            ← Back to case
          </Button>
          <span className="flex-1" />
          <Button onClick={() => void readAgain()} disabled={!!busy}>
            {busy === 'redact' ? (
              <span className="flex items-center gap-2">
                <Spinner size={14} /> Reading…
              </span>
            ) : rec.kind === 'image' ? (
              'Read again from the covered image'
            ) : (
              'Remove and read again'
            )}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={!canConfirm} title={canConfirm ? undefined : 'Read the covered file again first'}>
            {busy === 'confirm' ? 'Confirming…' : 'Confirm as evidence'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The image (an uploaded image, or a page of a PDF) with the areas to cover: drag to draw a rectangle; × removes one.
 * With `onTextArea` (a PDF page's «add text» mode) a drawn area goes there instead, and `textAreas` are outlined.
 */
export function ImageCover({
  src: srcOf,
  alt,
  noun,
  reviewed,
  rects,
  setRects,
  view,
  setView,
  disabled,
  onTextArea,
  textAreas = [],
}: {
  /** The URL of the uncovered original or of the covered file. */
  src: (v: 'original' | 'sanitised') => string;
  alt: string;
  /** What is shown: `image`, `page`. */
  noun: string;
  /** The server has a covered file to show. */
  reviewed: boolean;
  rects: Rect[];
  setRects: (f: (r: Rect[]) => Rect[]) => void;
  view: 'original' | 'sanitised';
  setView: (v: 'original' | 'sanitised') => void;
  disabled: boolean;
  onTextArea?: ((r: Rect) => void) | undefined;
  textAreas?: readonly Rect[];
}) {
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const src = srcOf(view);
  useEffect(() => setFailed(false), [src]);

  const at = (e: ReactPointerEvent) => {
    const b = img.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const shown = () => ({ width: img.current?.clientWidth ?? 0, height: img.current?.clientHeight ?? 0 });
  const pct = (r: Rect) =>
    natural ? { left: `${(r.x / natural.width) * 100}%`, top: `${(r.y / natural.height) * 100}%`, width: `${(r.w / natural.width) * 100}%`, height: `${(r.h / natural.height) * 100}%` } : {};
  const draft = drag && natural ? toImageRect(drag.a, drag.b, shown(), natural) : null;
  const drawing = view === 'original' && !disabled && !!natural;

  return (
    <>
      <div className="flex items-baseline justify-between gap-3 max-md:flex-col">
        <h3 className="m-0 text-[14px] font-semibold">
          {view !== 'original' ? 'The covered file: what is stored and sent' : onTextArea ? 'Drag over a line the reading missed, then type it' : 'Drag over what must not be shared'}
        </h3>
        {reviewed && (
          <div role="group" aria-label="Show" className="flex gap-1.5">
            <button type="button" aria-pressed={view === 'original'} onClick={() => setView('original')} className={cx('rounded-md border px-2 py-0.5 text-[12px]', view === 'original' ? 'border-acc bg-acc-soft text-acc' : 'border-line-2 bg-surface text-ink-2')}>
              Your covers
            </button>
            <button type="button" aria-pressed={view === 'sanitised'} onClick={() => setView('sanitised')} className={cx('rounded-md border px-2 py-0.5 text-[12px]', view === 'sanitised' ? 'border-acc bg-acc-soft text-acc' : 'border-line-2 bg-surface text-ink-2')}>
              Covered file
            </button>
          </div>
        )}
      </div>
      {failed ? (
        <p role="note" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          {view === 'original' ? `The original ${noun} is shown only to people who can edit this upload, until it is confirmed.` : 'The covered file could not be loaded.'}
        </p>
      ) : (
        <div className="relative self-start" style={{ touchAction: drawing ? 'none' : undefined }}>
          <img
            ref={img}
            src={src}
            alt={`${alt}${view === 'sanitised' ? ' (covered)' : ''}`}
            draggable={false}
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            className="block max-w-full select-none rounded-lg border border-line"
          />
          {view === 'original' && (
            <div
              data-testid="cover-surface"
              className={cx('absolute inset-0', drawing && 'cursor-crosshair')}
              onPointerDown={(e) => {
                if (!drawing || e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = at(e);
                setDrag({ a: p, b: p });
              }}
              onPointerMove={(e) => drag && setDrag({ a: drag.a, b: at(e) })}
              onPointerUp={(e) => {
                if (!drag || !natural) return;
                const r = toImageRect(drag.a, at(e), shown(), natural);
                setDrag(null);
                if (r) (onTextArea ? onTextArea(r) : setRects((all) => [...all, r]));
              }}
              onPointerCancel={() => setDrag(null)}
            >
              {rects.map((r, i) => (
                <div key={`${r.x}-${r.y}-${i}`} className="absolute bg-black" style={pct(r)}>
                  {!onTextArea && (
                    <button
                      type="button"
                      aria-label={`Remove covered area ${i + 1}`}
                      disabled={disabled}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setRects((all) => all.filter((_, j) => j !== i))}
                      className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full border border-line-2 bg-surface text-[12px] leading-none text-ink-2"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {textAreas.map((r, i) => (
                <div key={`t-${r.x}-${r.y}-${i}`} data-testid="text-area" className="pointer-events-none absolute border-2 border-acc" style={pct(r)}>
                  <span className="absolute -left-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-acc px-1 font-mono text-[10px] leading-none text-acc-ink">{i + 1}</span>
                </div>
              ))}
              {draft && <div className={cx('absolute border-2 border-dashed border-acc', onTextArea ? 'bg-transparent' : 'bg-black/60')} style={pct(draft)} />}
            </div>
          )}
        </div>
      )}
      <p className="m-0 text-[12.5px] text-ink-2">
        {rects.length ? `${rects.length} area${rects.length === 1 ? '' : 's'} covered.` : 'Nothing covered yet.'} Covered areas are blacked out in the stored file, which is read again from scratch: what is under them never reaches
        the analyst or PayPal.
      </p>
    </>
  );
}

/** The lines read, each editable: a corrected line is marked, with what was read and an Undo. */
export function LineEditor({ lines, read, setLines, disabled, empty, label = 'Lines read' }: { lines: string[]; read: readonly string[]; setLines: (f: (l: string[]) => string[]) => void; disabled: boolean; empty: string; label?: string }) {
  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {lines.map((l, i) => {
        const corrected = l !== read[i];
        return (
          <li key={i} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="w-6 flex-none text-right font-mono text-[11px] text-ink-3">{i + 1}</span>
              <input
                aria-label={`Line ${i + 1}`}
                value={l}
                disabled={disabled}
                onChange={(e) => setLines((all) => all.map((x, j) => (j === i ? e.target.value.replace(/[\r\n]/g, ' ') : x)))}
                className={cx('min-w-0 flex-1 rounded-md border bg-surface px-2 py-1 font-mono text-mono-frag', corrected ? 'border-warn-line' : 'border-line-2')}
              />
            </div>
            {corrected && (
              <span className="pl-8 text-[11.5px] text-warn">
                corrected by you · read as <span className="font-mono">{read[i] || '(empty)'}</span>{' '}
                <button type="button" onClick={() => setLines((all) => all.map((x, j) => (j === i ? read[i]! : x)))} className="border-0 bg-transparent p-0 text-[11.5px] text-ink-2 underline">
                  Undo
                </button>
              </span>
            )}
          </li>
        );
      })}
      {lines.length === 0 && <li className="text-[12.5px] text-ink-3">{empty}</li>}
    </ol>
  );
}

/** Pasted text: select a passage and remove it; removed passages are shown blacked out and can be kept again. */
function TextCover({ text, removals, setRemovals, disabled }: { text: string | null; removals: TextRemoval[]; setRemovals: (f: (r: TextRemoval[]) => TextRemoval[]) => void; disabled: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  const [selection, setSelection] = useState<TextRemoval | null>(null);
  const segments = useMemo(() => {
    if (text == null) return [];
    const out: { start: number; end: number; removed: boolean }[] = [];
    let pos = 0;
    for (const r of removals) {
      if (r.start > pos) out.push({ start: pos, end: r.start, removed: false });
      out.push({ start: r.start, end: r.end, removed: true });
      pos = r.end;
    }
    if (pos < text.length) out.push({ start: pos, end: text.length, removed: false });
    return out;
  }, [text, removals]);

  /** The selection as offsets into the pasted text (the box renders it exactly, removed spans included). */
  const readSelection = () => {
    const sel = window.getSelection();
    const el = box.current;
    if (!sel || sel.rangeCount === 0 || !el || sel.isCollapsed) return setSelection(null);
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return setSelection(null);
    const offset = (node: Node, at: number) => {
      const pre = document.createRange();
      pre.selectNodeContents(el);
      pre.setEnd(node, at);
      return pre.toString().length;
    };
    const start = offset(r.startContainer, r.startOffset);
    const end = offset(r.endContainer, r.endOffset);
    setSelection(end > start ? { start, end } : null);
  };

  if (text == null) {
    return (
      <>
        <h3 className="m-0 text-[14px] font-semibold">Pasted text</h3>
        <p role="note" className="m-0 rounded-lg border border-info-line bg-info-soft px-3 py-2 text-[12.5px] text-info">
          The pasted text stays only in the browser that pasted it. Read it again as it is{removals.length ? ' (with the passages removed before)' : ''}, or discard it and paste it again to remove passages.
        </p>
      </>
    );
  }
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[14px] font-semibold">Select what must not be shared</h3>
        <button
          type="button"
          disabled={disabled || !selection}
          onClick={() => {
            if (!selection) return;
            setRemovals((all) => mergeRemoval(all, selection));
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
          className="rounded-md border border-line-2 bg-surface px-2.5 py-[5px] text-[12px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Remove selected text
        </button>
      </div>
      <pre
        ref={box}
        aria-label="Pasted text"
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        className="m-0 whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-mono text-mono-frag leading-[1.6] [overflow-wrap:anywhere]"
      >
        {segments.map((s) =>
          s.removed ? (
            <mark key={s.start} className="bg-ink text-ink" title="Removed">
              {text.slice(s.start, s.end)}
            </mark>
          ) : (
            <span key={s.start}>{text.slice(s.start, s.end)}</span>
          ),
        )}
      </pre>
      {removals.length > 0 && (
        <ul aria-label="Removed passages" className="m-0 flex list-none flex-col gap-1 p-0">
          {removals.map((r, i) => (
            <li key={r.start} className="flex items-center gap-2 text-[12.5px] text-ink-2">
              Passage {i + 1} · {r.end - r.start} characters removed
              <button type="button" disabled={disabled} onClick={() => setRemovals((all) => all.filter((x) => x !== r))} className="border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
                Keep it
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[12.5px] text-ink-2">Removed passages become “[redacted]” in the PDF that is stored and sent; the analyst reads that PDF’s text.</p>
    </>
  );
}
