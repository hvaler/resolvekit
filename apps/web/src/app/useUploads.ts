import { useCallback, useEffect, useReducer } from 'react';
import { UploadRequestError, uploadsListReducer, type UploadRecordView, type UploadsClient } from '../domain/uploads';

/**
 * This workspace's uploads of a case, as the server lists them (domain/uploads `uploadsListReducer`). `known` once a
 * list came back, or there is no server; never after a failure alone. `refused` is the server's reason when this
 * person cannot add evidence here (signed out, other workspace); `error` why the last list request failed.
 */
export function useUploads(client: UploadsClient | null) {
  const [state, dispatch] = useReducer(uploadsListReducer, { uploads: [], known: !client, refused: null, error: null });

  const reload = useCallback(async () => {
    if (!client) return;
    try {
      dispatch({ type: 'loaded', uploads: await client.listUploads() });
    } catch (e) {
      // Not this person's to add (401/403): known, none, with the reason. Anything else is not "no uploads".
      if (e instanceof UploadRequestError && (e.status === 401 || e.status === 403)) dispatch({ type: 'refused', reason: e.message });
      else dispatch({ type: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }, [client]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** One upload as the server returned it after an action (null: gone). */
  const put = useCallback((id: string, upload: UploadRecordView | null) => dispatch({ type: 'put', id, upload }), []);

  return { ...state, reload, put };
}
