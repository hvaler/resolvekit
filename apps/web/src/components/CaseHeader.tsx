import type { CSSProperties, ReactNode } from 'react';
import { STAGE_LABEL } from '../domain/status';
import type { HeaderView } from '../domain/paypalView';
import { StatusLabel } from './StatusBadge';
import { Code, cx } from './ui';

function Cell({ label, children, first = false, className, style }: { label?: string; children: ReactNode; first?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx('flex flex-col gap-[3px]', first ? 'pr-[18px]' : 'border-l border-line px-4', className)} style={style}>
      {label && <span className="text-[11.5px] text-ink-3">{label}</span>}
      {children}
    </div>
  );
}

export interface CaseHeaderProps {
  /** What to show: demo data for a simulated case, PayPal's data for a bound one (see domain/paypalView). */
  view: HeaderView;
  /** Highlight the status cell (just re-read, or still processing). */
  statusHighlight?: boolean;
  processing?: boolean;
  wide?: boolean;
  className?: string;
}

/** Amount, reason and buyer-declared item type, stage, PayPal status, deadline, disputed transaction. */
export function CaseHeader({ view: v, statusHighlight = false, processing = false, wide = false, className }: CaseHeaderProps) {
  return (
    <div className={cx('flex flex-none flex-col bg-surface', className)}>
      {v.notice && (
        <p
          role="status"
          className={cx(
            'm-0 flex items-center gap-2 border-b border-line px-[22px] py-2 text-[12.5px]',
            v.notice.tone === 'bad' ? 'bg-bad-soft text-bad' : 'bg-info-soft text-info',
          )}
        >
          {v.notice.tone === 'info' && (
            <span aria-hidden="true" className="box-border h-3 w-3 flex-none animate-spin rounded-full border-[1.5px] border-line-2 border-t-info" />
          )}
          {v.notice.text}
        </p>
      )}
      <div
        className="grid px-[22px] py-3.5"
        style={{
          gridTemplateColumns: wide
            ? 'minmax(0,1.9fr) minmax(0,.7fr) minmax(0,1.2fr) minmax(0,.85fr) minmax(0,1.2fr)'
            : 'minmax(0,1.7fr) minmax(0,.75fr) minmax(0,1.25fr) minmax(0,.9fr) minmax(0,1.2fr)',
        }}
      >
        <Cell first className="gap-0.5">
          <span className="text-display" data-testid="case-amount">
            {v.amount} {v.currency && <span className="text-[16px] font-normal text-ink-2">{v.currency}</span>}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium">{v.reasonText}</span>
            {(v.itemType || v.reasonCode) && (
              <span title="Item type declared by the buyer when opening the dispute" className="rounded-sm border border-line-2 px-[7px] py-0.5 text-[11.5px] text-ink-2">
                Buyer declared: {v.itemType ?? 'not reported by PayPal'}
              </span>
            )}
          </span>
          {v.reasonCode && <Code>{v.reasonCode}</Code>}
          {v.disputeLine && <span className="font-mono text-caption leading-[1.3] text-ink-3">{v.disputeLine}</span>}
        </Cell>
        <Cell label="Stage">
          {v.stage ? (
            <>
              <span className="text-[14px] font-medium">{STAGE_LABEL[v.stage] ?? v.stage}</span>
              <Code>{v.stage}</Code>
            </>
          ) : (
            <span className="text-[14px] font-medium text-ink-3">{v.stageEmpty}</span>
          )}
        </Cell>
        <Cell
          label="PayPal status"
          className={cx('-my-1 py-1 transition-[background] duration-status', statusHighlight && v.status && 'bg-info-soft')}
        >
          <div aria-live="polite" className="flex flex-col gap-[3px]">
            {v.status ? <StatusLabel status={v.status} pulse={processing} /> : <span className="text-[14px] font-medium text-ink-3">—</span>}
            <Code>{v.statusDetail}</Code>
          </div>
        </Cell>
        <Cell label="Respond by">
          {v.due ? (
            <>
              <span className="text-[14px] font-medium">{v.due.at}</span>
              <span className="font-mono text-caption font-medium leading-[1.3] text-ink-2">{v.due.left}</span>
            </>
          ) : (
            <>
              <span className="text-[14px] font-medium text-ink-3">{v.dueEmpty.text}</span>
              {v.dueEmpty.sub && <span className="text-[12px] text-ink-2">{v.dueEmpty.sub}</span>}
            </>
          )}
        </Cell>
        <Cell label="Disputed transaction" className="pr-0">
          <span className="font-mono text-mono-id">{v.transactionId}</span>
          <span className="text-[12px] text-ink-2">{v.transactionText}</span>
        </Cell>
      </div>
      {v.mismatch && (
        <p role="alert" className="m-0 flex items-start gap-2 border-t border-warn-line bg-warn-soft px-[22px] py-2 text-[12.5px] text-warn">
          <span aria-hidden="true" className="mt-[5px] h-[7px] w-[7px] flex-none rotate-45 bg-warn" />
          <span>
            <strong className="font-semibold">Demo binding mismatch.</strong> {v.mismatch}
          </span>
        </p>
      )}
    </div>
  );
}
