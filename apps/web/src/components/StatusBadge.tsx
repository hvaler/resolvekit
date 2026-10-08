import { INBOX_STATE_DISPLAY, STATUS_DISPLAY } from '../domain/status';
import type { DisputeStatus, InboxState } from '../domain/types';
import { TONE_FG, TONE_LINE, TONE_SOFT, cx } from './ui';

export function StatusDot({ status, pulse = false, size = 8 }: { status: DisputeStatus; pulse?: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block flex-none rounded-full', pulse && 'animate-rkpulse')}
      style={{ width: size, height: size, background: TONE_FG[STATUS_DISPLAY[status].tone] }}
    />
  );
}

/** Dot + human label. The raw PayPal code is shown next to it by the caller. */
export function StatusLabel({ status, pulse = false }: { status: DisputeStatus; pulse?: boolean }) {
  return (
    <span className="flex items-center gap-[7px] text-[14px] font-medium">
      <StatusDot status={status} pulse={pulse} />
      {STATUS_DISPLAY[status].label}
    </span>
  );
}

/** Workflow state of a case in the inbox. */
export function StateBadge({ state }: { state: InboxState }) {
  const d = INBOX_STATE_DISPLAY[state];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded px-2 py-[3px] text-[11.5px] font-medium"
      style={{
        border: `1px ${d.dashed ? 'dashed' : 'solid'} ${TONE_LINE[d.tone]}`,
        background: state === 'closed' ? 'transparent' : TONE_SOFT[d.tone],
        color: TONE_FG[d.tone],
      }}
    >
      {state === 'processing' && <span aria-hidden="true" className="h-1.5 w-1.5 animate-rkpulse rounded-full bg-info" />}
      {d.label}
    </span>
  );
}
