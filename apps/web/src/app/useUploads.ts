import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialPoll, pollStep, runningJobs } from '../domain/pdfReview';
import { UploadRequestError, uploadsListReducer, type UploadRecordView, type UploadsClient } from '../domain/uploads';

/**
 * This workspace's uploads of a case, as the server lists them (domain/uploads `uploadsListReducer`). `known` once a
 * list came back, when no server is behind the request, or without a server at all; never after the uploads route's
 * own error alone. `refused` is the server's reason when this person cannot add evidence here (signed out, other
 * workspace); `error` why the last list request failed. A failed list is retried by itself (`listRetryDelay`), so a
 * deploy window clears without a click.
 * The same timer follows running PDF jobs (`pollStep`: backoff while a job does not move, stop when none runs, on 401/403,
 * on unmount, or after `STUCK_MS` without progress: `stuck`). `who` (person and workspace) reloads it when someone signs in.
 */
export function useUploads(client: UploadsClient | null, who = '') {
  const [state, dispatch] = useReducer(uploadsListReducer, { uploads: [], known: !client, refused: null, error: null });
  const poll = useRef(initialPoll());
  const [stuck, setStuck] = useState(false);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!client) return;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const mine = ++seq.current;
    try {
      const uploads = await client.listUploads();
      if (mine !== seq.current) return;
      dispatch({ type: 'loaded', uploads });
      const step = pollStep(poll.current, { type: 'ok', jobs: runningJobs(uploads), now: Date.now() });
      poll.current = step.state;
      setStuck(step.stuck);
      if (step.delay != null) timer.current = window.setTimeout(() => void reload(), step.delay);
    } catch (e) {
      if (mine !== seq.current) return;
      // Not this person's to add (401/403): known, none, with the reason. Anything else is not "no uploads".
      if (e instanceof UploadRequestError && (e.status === 401 || e.status === 403)) {
        poll.current = initialPoll();
        dispatch({ type: 'refused', reason: e.message });
        return;
      }
      const err = e instanceof UploadRequestError ? e : null;
      dispatch({ type: 'failed', error: e instanceof Error ? e.message : String(e), status: err?.status ?? 0, code: err?.code ?? 'SERVER_UNREACHABLE' });
      const step = pollStep(poll.current, { type: 'error', status: err?.status ?? 0, now: Date.now() });
      poll.current = step.state;
      if (step.delay != null) timer.current = window.setTimeout(() => void reload(), step.delay);
    }
  }, [client]);

  useEffect(() => {
    poll.current = initialPoll();
    setStuck(false);
    void reload();
    return () => {
      seq.current++;
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [reload, who]);

  /** A click: start the retries over. */
  const retry = useCallback(() => {
    poll.current = initialPoll();
    return reload();
  }, [reload]);

  /** One upload as the server returned it after an action (null: gone). */
  const put = useCallback((id: string, upload: UploadRecordView | null) => dispatch({ type: 'put', id, upload }), []);

  return { ...state, stuck, reload: retry, put };
}
