import { jobLabel } from '../domain/pdfReview';
import type { PdfJob } from '../domain/uploads';
import { Spinner } from './ui';

/** Where the reading of a PDF is: a spinner while it runs, the reason when it failed. */
export function PdfProgress({ job }: { job: PdfJob }) {
  const failed = job.state === 'failed';
  return (
    <span role={failed ? 'alert' : 'status'} className={failed ? 'text-[12px] text-bad' : 'flex items-center gap-1.5 text-[12px] text-ink-2'}>
      {!failed && <Spinner size={13} />}
      {jobLabel(job)}
    </span>
  );
}

/** What the Review action of a PDF opens until the review of its pages exists. */
export function PdfReviewPlaceholder({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <section aria-label={`Review ${name}`} className="flex flex-wrap items-center gap-2.5 rounded-2xl border border-acc-line bg-surface px-4 py-3 text-[12.5px]">
      <span className="min-w-0 flex-1">
        <strong>{name}</strong> has been read. Reviewing its pages is not available in this version yet; it stays pending and is not used.
      </span>
      <button type="button" onClick={onClose} className="border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
        Close
      </button>
    </section>
  );
}
