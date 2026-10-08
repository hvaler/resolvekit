import type { CSSProperties, ReactNode } from 'react';
import { STAGE_LABEL } from '../domain/status';
import type { DisputeStatus, DisputeSummary } from '../domain/types';
import { StatusLabel } from './StatusBadge';
import { Code, cx } from './ui';

function Cell({ label, children, first = false, className, style }: { label?: string; children: ReactNode; first?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx('flex flex-col gap-[3px]', first ? 'pr-[18px]' : 'border-l border-line px-4', className)} style={style}>
      {label && <span className="text-[11.5px] text-ink3">{label}</span>}
      {children}
    </div>
  );
}

export interface CaseHeaderProps {
  summary: DisputeSummary;
  /** Current PayPal status (may differ from the fixture after a re-read). */
  status: DisputeStatus;
  /** Second line under the status: code plus when it was read. */
  statusDetail: string;
  /** Highlight the status cell (just re-read, or still processing). */
  statusHighlight?: boolean;
  processing?: boolean;
  wide?: boolean;
  className?: string;
}

/** Amount, reason and buyer-declared item type, stage, PayPal status, deadline, disputed transaction. */
export function CaseHeader({ summary: s, status, statusDetail, statusHighlight = false, processing = false, wide = false, className }: CaseHeaderProps) {
  return (
    <div
      className={cx('grid flex-none bg-surface px-[22px] py-3.5', className)}
      style={{
        gridTemplateColumns: wide
          ? 'minmax(0,1.9fr) minmax(0,.7fr) minmax(0,1.2fr) minmax(0,.85fr) minmax(0,1.2fr)'
          : 'minmax(0,1.7fr) minmax(0,.75fr) minmax(0,1.25fr) minmax(0,.9fr) minmax(0,1.2fr)',
      }}
    >
      <Cell first className="gap-0.5">
        <span className="text-[24px] font-semibold leading-[1.1] tracking-[-0.01em]">
          {s.amount} <span className="text-[16px] font-normal text-ink2">{s.currency}</span>
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium">{s.reasonText}</span>
          <span title="Item type declared by the buyer when opening the dispute" className="rounded border border-line2 px-[7px] py-0.5 text-[11.5px] text-ink2">
            Buyer declared: {s.buyerItemType}
          </span>
        </span>
        <Code>{s.reason}</Code>
      </Cell>
      <Cell label="Stage">
        {s.stage ? (
          <>
            <span className="text-[14px] font-medium">{STAGE_LABEL[s.stage] ?? s.stage}</span>
            <Code>{s.stage}</Code>
          </>
        ) : (
          <span className="text-[14px] font-medium text-ink3">Not set yet</span>
        )}
      </Cell>
      <Cell
        label="PayPal status"
        className="-my-1 py-1 transition-[background] duration-1000"
        style={{ background: statusHighlight ? 'var(--info-soft)' : 'transparent' }}
      >
        <div aria-live="polite" className="flex flex-col gap-[3px]">
          <StatusLabel status={status} pulse={processing} />
          <Code>{statusDetail}</Code>
        </div>
      </Cell>
      <Cell label="Respond by">
        {s.respondBy ? (
          <>
            <span className="text-[14px] font-medium">{s.respondBy}</span>
            <span className="font-mono text-[11.5px] font-medium leading-[1.3] text-ink2">{s.timeLeft}</span>
          </>
        ) : (
          <span className="text-[14px] font-medium text-ink3">Set when it opens</span>
        )}
      </Cell>
      <Cell label="Disputed transaction" className="pr-0">
        <span className="font-mono text-[12.5px] font-medium leading-[1.3]">{s.transactionId}</span>
        <span className="text-[12px] text-ink2">{s.captureText}</span>
      </Cell>
    </div>
  );
}
