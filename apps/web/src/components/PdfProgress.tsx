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
