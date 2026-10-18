import { useEffect, useState } from 'react';
import { PDF_MAX_SELECTED, SELECTION_WARNING, canPick, pickedLabel, selectionCopy, togglePick } from '../domain/pdfReview';
import { UploadRequestError, type UploadRecordView, type UploadsClient } from '../domain/uploads';
import { Button, cx } from './ui';

const message = (e: unknown) => (e instanceof UploadRequestError || e instanceof Error ? e.message : String(e));

/** A thumbnail that is asked for again (up to 3 times, 1.5 s apart) when it fails, and shows a placeholder after that, never a broken image. */
function Thumb({ src }: { src: string }) {
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed || tries >= 3) return;
    const t = window.setTimeout(() => {
      setTries((n) => n + 1);
      setFailed(false);
    }, 1_500);
    return () => window.clearTimeout(t);
  }, [failed, tries]);
  if (failed && tries >= 3) return <span className="flex h-[130px] w-full items-center justify-center rounded-sm bg-bg text-[11px] text-ink-3">No preview</span>;
  return <img key={tries} src={`${src}${tries ? `?retry=${tries}` : ''}`} alt="" loading="lazy" onError={() => setFailed(true)} className="h-[130px] w-full rounded-sm bg-bg object-contain" />;
}

/**
 * A PDF of more than 5 pages waits here for the pages to add: its thumbnails (labelled with their number in the
 * original document), at most 5 picks, and the warning about leaving out pages the dispute needs. The server then
 * renders and reads only the chosen pages.
 */
export function PdfSelect({ upload, client, onSelected, onClose }: { upload: UploadRecordView; client: UploadsClient; onSelected: (u: UploadRecordView) => void; onClose: () => void }) {
  const count = upload.pdf?.pageCount ?? 0;
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      onSelected(await client.select(upload.id, picked));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={`Choose the pages of ${upload.name}`} className="flex flex-col gap-2.5 rounded-2xl border border-acc-line bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[13.5px] font-semibold">{upload.name}</h3>
        <button type="button" onClick={onClose} disabled={busy} className="border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
          Close
        </button>
      </div>
      <p className="m-0 text-[12.5px]">{selectionCopy(count)}</p>
      <p className="m-0 text-[12px] text-warn">{SELECTION_WARNING}</p>
      <ul aria-label="Pages of the document" className="m-0 flex list-none flex-wrap gap-2 p-0">
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => {
          const on = picked.includes(n);
          return (
            <li key={n}>
              <button
                type="button"
                aria-pressed={on}
                aria-label={pickedLabel(n)}
                disabled={busy || !canPick(picked, n)}
                onClick={() => setPicked((p) => togglePick(p, n))}
                className={cx('flex w-[104px] flex-col items-center gap-1 rounded-lg border bg-surface p-1.5 text-[11.5px] disabled:cursor-not-allowed disabled:opacity-50', on ? 'border-acc bg-acc-soft' : 'border-line-2')}
              >
                <Thumb src={client.thumbUrl(upload.id, n)} />
                <span className="font-mono">{on ? `✓ ${n}` : n}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-[12px] text-ink-2" role="status">
        {picked.length ? `${picked.map(pickedLabel).join(' · ')} (${picked.length} of ${PDF_MAX_SELECTED})` : `No page chosen yet (up to ${PDF_MAX_SELECTED})`}
      </p>
      {error && (
        <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft px-3 py-2 text-body">
          {error}
        </div>
      )}
      <div>
        <Button className="h-8 text-[12.5px]" disabled={busy || !picked.length} onClick={() => void choose()}>
          {busy ? 'Starting…' : picked.length ? `Add ${picked.length} page${picked.length === 1 ? '' : 's'}` : 'Add pages'}
        </Button>
      </div>
    </section>
  );
}
