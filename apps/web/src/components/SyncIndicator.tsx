import { POLL_MS, useSecondsSince } from '../app/services';
import { cx } from './ui';

const POLL_S = Math.round(POLL_MS / 1000);

/** "Synced with PayPal · last checked 12s ago". Turns to a warning when the last read is stale. */
export function SyncIndicator({ checkedAt }: { checkedAt: number | null }) {
  const secs = useSecondsSince(checkedAt);
  const stale = secs != null && secs > POLL_S * 3;
  return (
    <span className="flex items-center gap-[7px] text-[12px] text-ink2">
      <span aria-hidden="true" className={cx('h-[7px] w-[7px] rounded-full', stale ? 'bg-warn' : 'bg-ok')} />
      {secs == null ? 'Not synced yet' : `${stale ? 'Sync delayed' : 'Synced with PayPal'} · last checked ${secs}s ago`}
    </span>
  );
}

/** "Checked 12s ago · next in 18s" for the processing state. */
export function PollCountdown({ checkedAt }: { checkedAt: number | null }) {
  const secs = useSecondsSince(checkedAt);
  const next = secs == null ? null : Math.max(0, POLL_S - (secs % POLL_S));
  return (
    <span className="font-mono text-[11.5px] font-medium leading-none text-ink2">
      {secs == null ? 'Not checked yet' : `Checked ${secs}s ago · next in ${next}s`}
    </span>
  );
}
