import { STATUS_DISPLAY } from '../domain/status';
import type { DisputeStatus } from '../domain/types';
import { TONE_FG, cx } from './ui';

export function StatusDot({ status, pulse = false, size = 8 }: { status: DisputeStatus; pulse?: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block flex-none rounded-full', pulse && 'animate-pulse')}
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
