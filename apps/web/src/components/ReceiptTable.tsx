import { isFragmentLit, type Highlight } from '../app/highlight';
import { chargedTotal } from '../domain/receipt';
import type { ReceiptCall } from '../domain/types';

const COLS = 'grid grid-cols-[26px_74px_minmax(0,1fr)_62px_150px_92px] gap-2.5 px-3';

/** Per-call receipt: every tool call with price, status and request hash. Failed calls are not charged. */
export function ReceiptTable({ id, calls, currency, hl }: { id: string; calls: ReceiptCall[]; currency: string; hl: Highlight | null }) {
  const { total, parts } = chargedTotal(calls);
  return (
    <div role="table" aria-label="Per-call receipt" className="overflow-hidden rounded-[7px] border border-line">
      <div role="row" className={`${COLS} border-b border-line bg-surface-2 py-[7px] text-[11.5px] font-medium text-ink-3`}>
        <span role="columnheader">#</span>
        <span role="columnheader">Time</span>
        <span role="columnheader">Tool</span>
        <span role="columnheader" className="text-right">
          Price
        </span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Request hash</span>
      </div>
      {calls.map((r) => {
        const lit = isFragmentLit(hl, id, r.fragment);
        return (
          <div
            key={r.fragment}
            role="row"
            className={`${COLS} items-center border-b border-line py-2 font-mono text-[12.5px] leading-[1.3] transition-[background] duration-fast`}
            style={{ background: lit ? 'var(--hl)' : 'transparent' }}
          >
            <span role="cell" className="text-ink-3">
              {r.n}
            </span>
            <span role="cell" className="text-ink-2">
              {r.time}
            </span>
            <span role="cell" className="font-medium">
              {r.tool}
            </span>
            <span role="cell" className="text-right" style={{ color: r.ok ? 'var(--ink)' : 'var(--ink3)', textDecoration: r.ok ? 'none' : 'line-through' }}>
              {r.price}
              {!r.ok && <span className="sr-only"> (not charged)</span>}
            </span>
            <span role="cell">
              <span
                className="inline-block rounded-sm px-1.5 py-0.5 font-sans text-[11px] font-semibold leading-[1.3]"
                style={{ background: r.ok ? 'var(--ok-soft)' : 'var(--bad-soft)', color: r.ok ? 'var(--ok)' : 'var(--bad)' }}
              >
                {r.ok ? 'OK' : 'FAILED · not charged'}
              </span>
            </span>
            <span role="cell" className="text-[11.5px] text-ink-3">
              {r.hash}
            </span>
          </div>
        );
      })}
      <div role="row" className={`${COLS} items-center bg-surface-2 py-[9px] text-[12.5px]`}>
        <span role="cell" />
        <span role="cell" />
        <span role="cell" className="font-semibold">
          Total charged · {parts.length} OK calls
        </span>
        <span role="cell" className="text-right font-mono text-body font-semibold leading-none">
          {total}
        </span>
        <span role="cell" className="font-mono text-[11.5px] text-ink-2">
          {parts.join(' + ')}
        </span>
        <span role="cell" className="text-[11.5px] text-ink-3">
          {currency}
        </span>
      </div>
    </div>
  );
}
