import { useCallback, useEffect, useState } from 'react';
import { UploadRequestError, type UploadRecordView, type UploadsClient } from '../domain/uploads';

/**
 * This workspace's uploads of a case, as the server lists them. `known` once the list came back (or there is no
 * server); `refused` is the server's reason when this person cannot add evidence here (signed out, other workspace).
 */
export function useUploads(client: UploadsClient | null) {
  const [uploads, setUploads] = useState<UploadRecordView[]>([]);
  const [known, setKnown] = useState(!client);
  const [refused, setRefused] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      setUploads(await client.listUploads());
      setRefused(null);
    } catch (e) {
      // Not this person's to add (401/403): the reason goes on "+ Add evidence". Otherwise the case has none to show.
      if (e instanceof UploadRequestError && (e.status === 401 || e.status === 403)) setRefused(e.message);
      setUploads([]);
    } finally {
      setKnown(true);
    }
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** One upload as the server returned it after an action (null: gone). */
  const put = useCallback((id: string, u: UploadRecordView | null) => {
    setUploads((all) => {
      const rest = all.filter((x) => x.id !== id);
      return u && ['pending', 'reviewing', 'confirmed'].includes(u.status) ? [...rest, u].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : rest;
    });
  }, []);

  return { uploads, known, refused, reload, put };
}
