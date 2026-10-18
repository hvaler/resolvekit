import { useEffect, useRef } from 'react';
import { jobSettled, pollDelay } from '../domain/pdfReview';
import type { UploadRecordView, UploadsClient } from '../domain/uploads';

/**
 * Follows the PDF uploads whose job is still running (rendering, reading, or making thumbnails): asks the server for
 * the list again with `pollDelay` backoff and hands each of those uploads back through `put`; stops by itself once
 * every job has settled (reviewing, failed, or waiting for a selection). A failed request is tried again, never fatal.
 */
export function usePdfJobs(client: UploadsClient | null, uploads: readonly UploadRecordView[], put: (id: string, u: UploadRecordView | null) => void) {
  const running = uploads.filter((u) => u.pdf && !jobSettled(u.pdf.job)).map((u) => u.id);
  const key = running.join(',');
  const putRef = useRef(put);
  putRef.current = put;

  useEffect(() => {
    if (!client || !key) return;
    const ids = new Set(key.split(','));
    let attempt = 0;
    let timer: number | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const list = await client.listUploads();
        if (stopped) return;
        for (const id of ids) putRef.current(id, list.find((u) => u.id === id) ?? null);
      } catch {
        /* the next tick asks again */
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), pollDelay(attempt++));
    };
    timer = window.setTimeout(() => void tick(), pollDelay(attempt++));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [client, key]);
}
