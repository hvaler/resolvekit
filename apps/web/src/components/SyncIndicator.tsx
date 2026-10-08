import { POLL_MS, useSecondsSince, useServices } from '../app/services';
import { cx } from './ui';

const POLL_S = Math.round(POLL_MS / 1000);

function age(secs: number): string {
  return secs < 120 ? `${secs}s ago` : `${Math.round(secs / 60)} min ago`;
}

/**
 * How fresh the PayPal data is: "Synced with PayPal · last checked 12s ago", a spinner while a read is in
 * flight (the data stays usable), or "Couldn't reach PayPal … showing saved data" with Retry. Only changes of
 * state are announced, not every second.
 */
export function SyncIndicator({ checkedAt, onRetry }: { checkedAt: number | null; onRetry?: () => void }) {
  const secs = useSecondsSince(checkedAt);
  const { sync } = useServices();
  const stale = secs != null && secs > POLL_S * 3;
  const state = sync.syncing ? 'syncing' : sync.failed ? 'failed' : stale ? 'stale' : 'ok';
  const announce = { syncing: 'Syncing with PayPal', failed: 'Couldn’t reach PayPal. Showing saved data.', stale: 'Sync delayed', ok: 'Synced with PayPal' }[state];
  const live = (
    <span role="status" className="sr-only">
      {announce}
    </span>
  );

  if (state === 'failed') {
    return (
      <span className="flex items-center gap-2 rounded-md border border-warn-line bg-warn-soft py-0.5 pl-2 pr-0.5 text-[12px] text-ink">
        <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-warn" />
        <span>
          Couldn’t reach PayPal{secs != null && ` · last checked ${age(secs)}`} · showing saved data
        </span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="h-6 rounded-md border border-warn-line bg-surface px-[9px] text-[12px]">
            Retry
          </button>
        )}
        {live}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-[7px] text-[12px] text-ink-2">
      {state === 'syncing' ? (
        <span aria-hidden="true" className="box-border h-2.5 w-2.5 animate-spin rounded-full border-2 border-line-2 border-t-acc" />
      ) : (
        <span aria-hidden="true" className={cx('h-[7px] w-[7px] rounded-full', stale ? 'bg-warn' : 'bg-ok')} />
      )}
      <span>
        {state === 'syncing'
          ? 'Syncing with PayPal…'
          : secs == null
            ? 'Not synced yet'
            : `${stale ? 'Sync delayed' : 'Synced with PayPal'} · last checked ${secs}s ago`}
      </span>
      {live}
    </span>
  );
}

/** "Checked 12s ago · next in 18s" for the processing state. */
export function PollCountdown({ checkedAt }: { checkedAt: number | null }) {
  const secs = useSecondsSince(checkedAt);
  const next = secs == null ? null : Math.max(0, POLL_S - (secs % POLL_S));
  return (
    <span className="font-mono text-caption font-medium leading-none text-ink-2">
      {secs == null ? 'Not checked yet' : `Checked ${secs}s ago · next in ${next}s`}
    </span>
  );
}
