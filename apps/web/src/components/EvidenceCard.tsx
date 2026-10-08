import { isFragmentLit, useHighlight, useHoverHighlight, type Highlight } from '../app/highlight';
import type { Evidence, EvidenceLine, KeyValueRow } from '../domain/types';
import { ReceiptTable } from './ReceiptTable';
import { EvidenceTag } from './ui';

export const evidenceDomId = (id: string) => `evidence-${id}`;

function usedText(n: number, caption?: string): string {
  const used = n ? `used in ${n} claim${n > 1 ? 's' : ''}` : 'not used in any claim';
  const text = caption ? `${caption} · ${used}` : used;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function SourceLines({ id, lines, hl }: { id: string; lines: EvidenceLine[]; hl: Highlight | null }) {
  return (
    <div className="flex flex-col rounded-md border border-line bg-surface2 py-[5px]">
      {lines.map((l, i) => {
        const lit = isFragmentLit(hl, id, l.fragment);
        return (
          <span
            key={i}
            className="px-2.5 py-[3px] font-mono text-[12px] leading-[1.5] transition-[background] duration-200"
            style={{ background: lit ? 'var(--hl)' : 'transparent', boxShadow: lit ? 'inset 3px 0 0 var(--acc)' : 'none' }}
          >
            {l.text}
            {lit && <span className="sr-only"> (cited)</span>}
          </span>
        );
      })}
    </div>
  );
}

function KeyValues({ id, rows, hl }: { id: string; rows: KeyValueRow[]; hl: Highlight | null }) {
  return (
    <dl className="m-0 grid grid-cols-[120px_minmax(0,1fr)] border-t border-line">
      {rows.map((r) => {
        const bg = isFragmentLit(hl, id, r.fragment) ? 'var(--hl)' : 'transparent';
        return (
          <div key={r.fragment} className="contents">
            <dt className="border-b border-line p-1.5 text-[12px] text-ink3" style={{ background: bg }}>
              {r.label}
            </dt>
            <dd className="m-0 border-b border-line py-1.5 font-mono text-[12px] font-medium leading-[1.4]" style={{ background: bg }}>
              {r.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One document in the case file: provenance, hash, and its content with cited fragments lit. */
export function EvidenceCard({ evidence: e, used, contradictionOpen }: { evidence: Evidence; used: number; contradictionOpen: boolean }) {
  const { hl } = useHighlight();
  const hover = useHoverHighlight();
  const on = hl?.ev === e.id;
  const b = e.body;

  return (
    <article
      id={evidenceDomId(e.id)}
      tabIndex={0}
      aria-label={`Evidence ${e.id}: ${e.title}`}
      {...hover({ ev: e.id, frags: [] })}
      className="flex scroll-mt-4 flex-col gap-[9px] rounded-[10px] bg-surface px-4 pb-3.5 pt-3 transition-[border-color,box-shadow] duration-200"
      style={{ border: `1px solid ${on ? 'var(--acc)' : 'var(--line)'}`, boxShadow: on ? '0 0 0 3px var(--hl)' : 'none' }}
    >
      <div className="flex items-center gap-[9px]">
        <EvidenceTag id={e.id} />
        <span className="min-w-0 flex-1 text-[14px] font-semibold">{e.title}</span>
        {contradictionOpen && (
          <span className="inline-flex items-center gap-[5px] rounded bg-warn-soft px-[7px] py-0.5 text-[11.5px] font-medium text-warn">
            <span aria-hidden="true" className="h-1.5 w-1.5 rotate-45 bg-warn" />
            Address differs
          </span>
        )}
        <span className="text-[12px]" style={{ color: used ? 'var(--ink2)' : 'var(--ink3)' }}>
          {usedText(used, e.caption)}
        </span>
      </div>

      {e.meta && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink2">
          <span>{e.meta.type}</span>
          <span className="flex items-center gap-[5px]">
            <span className="rounded-[3px] border border-line2 px-1 py-[3px] font-mono text-[9px] font-medium leading-none">{e.meta.tag}</span>
            {e.meta.source}
          </span>
          <span>Received {e.meta.received}</span>
          <span className="font-mono text-[11px] leading-[1.4] text-ink3">sha256 {e.meta.hash}</span>
        </div>
      )}

      {e.warning && (
        <div role="note" className="flex items-center gap-2 rounded-md border border-info-line bg-info-soft px-2.5 py-[7px] text-[12.5px] text-info">
          <span aria-hidden="true" className="font-mono text-[11px] font-semibold leading-none">
            i
          </span>
          {e.warning}
        </div>
      )}

      {b.kind === 'lines' && <SourceLines id={e.id} lines={b.lines} hl={hl} />}

      {b.kind === 'mandate' && (
        <>
          <div className="text-[15px] font-medium leading-[1.4]">
            {b.headline} <span className="font-mono text-[14px]">{b.sessionId}</span>
          </div>
          <KeyValues id={e.id} rows={b.rows} hl={hl} />
        </>
      )}

      {b.kind === 'receipt' && <ReceiptTable id={e.id} calls={b.calls} currency={b.currency} hl={hl} />}

      {b.kind === 'settlement' && (
        <>
          <div className="text-[15px] font-medium">{b.headline}</div>
          <div className="flex flex-col gap-[5px]">
            <div
              role="meter"
              aria-label="Captured of the approved budget"
              aria-valuemin={0}
              aria-valuemax={Number(b.cap)}
              aria-valuenow={Number(b.captured)}
              className="h-2 overflow-hidden rounded bg-line"
            >
              <span className="block h-full bg-acc" style={{ width: `${(Number(b.captured) / Number(b.cap)) * 100}%` }} />
            </div>
            <div className="flex justify-between font-mono text-[11.5px] font-medium leading-none text-ink2">
              <span>{b.captured} captured</span>
              <span className="text-ink3">
                {b.released} released · cap {b.cap}
              </span>
            </div>
          </div>
          <KeyValues id={e.id} rows={b.rows} hl={hl} />
        </>
      )}
    </article>
  );
}
