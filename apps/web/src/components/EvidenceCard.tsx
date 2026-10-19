import { Fragment, type ReactNode } from 'react';
import { isFragmentLit, useHighlight, useHoverHighlight, type Highlight } from '../app/highlight';
import type { Evidence, EvidenceLine, KeyValueRow } from '../domain/types';
import { pageOf } from '../domain/draft';
import { pageLabel, provenanceOf, transcribedLabel, type Provenance } from '../domain/uploads';
import { ReceiptGrid } from './ReceiptGrid';
import { EvidenceTag, cx } from './ui';

export const evidenceDomId = (id: string) => `evidence-${id}`;

/** The provenance badge's colours: real data (MeterMCP, PayPal, ResolveKit's run record), a merchant upload, or a synthetic demo document. */
export const PROVENANCE_CLASS: Record<Provenance['kind'], string> = {
  metermcp: 'border border-ok-line bg-ok-soft text-ok',
  paypal: 'border border-ok-line bg-ok-soft text-ok',
  resolvekit: 'border border-ok-line bg-ok-soft text-ok',
  upload: 'border border-acc-line bg-acc-soft text-acc',
  demo: 'border border-dashed border-info-line bg-info-soft text-info',
};

function usedText(n: number, caption?: string): string {
  const used = n ? `used in ${n} claim${n > 1 ? 's' : ''}` : 'not used in any claim';
  const text = caption ? `${caption} · ${used}` : used;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The lines of a document; a PDF upload's under the label of each page of the original document they are on. */
function SourceLines({ id, lines, hl }: { id: string; lines: EvidenceLine[]; hl: Highlight | null }) {
  const pages = lines.map((l) => (l.fragment ? pageOf(l.fragment)?.page : undefined));
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface-2 py-[5px]">
      {lines.map((l, i) => {
        const lit = isFragmentLit(hl, id, l.fragment);
        const page = pages[i];
        return (
          <Fragment key={i}>
            {page !== undefined && page !== pages[i - 1] && (
              <span data-testid="page-label" className={cx('px-2.5 pb-[2px] pt-[5px] font-sans text-[11px] font-medium text-ink-3', i > 0 && 'mt-1 border-t border-line')}>
                {pageLabel(page)}
              </span>
            )}
            <span className={cx('px-2.5 py-[3px] font-mono text-mono-frag transition-[background] duration-fast', lit && 'bg-hl shadow-rule-acc')}>
              {l.text}
              {l.corrected && (
                <span data-testid="corrected-mark" className="ml-2 whitespace-nowrap rounded-xs border border-warn-line bg-warn-soft px-1 py-px font-sans text-[10.5px] text-warn">
                  corrected by {l.corrected}
                </span>
              )}
              {l.transcribed && (
                <span data-testid="transcribed-mark" className="ml-2 whitespace-nowrap rounded-xs border border-acc-line bg-acc-soft px-1 py-px font-sans text-[10.5px] text-acc">
                  {transcribedLabel(l.transcribed)}
                </span>
              )}
              {lit && <span className="sr-only"> (cited)</span>}
            </span>
          </Fragment>
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
            <dt className="border-b border-line p-1.5 text-[12px] text-ink-3" style={{ background: bg }}>
              {r.label}
            </dt>
            <dd className="m-0 border-b border-line py-1.5 font-mono text-mono-frag font-medium leading-[1.4]" style={{ background: bg }}>
              {r.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One document in the case file: provenance, hash, and its content with cited fragments lit. */
export function EvidenceCard({
  evidence: e,
  used,
  contradictionOpen,
  contradictionLabel = 'Contradiction',
  actions,
}: {
  evidence: Evidence;
  used: number;
  contradictionOpen: boolean;
  /** Badge text while the contradiction this document is part of is open, e.g. "Address contradiction". */
  contradictionLabel?: string;
  /** Controls for the document (e.g. deleting an upload), after its badges. */
  actions?: ReactNode;
}) {
  const { hl } = useHighlight();
  const hover = useHoverHighlight();
  const on = hl?.ev === e.id;
  const b = e.body;
  const prov = provenanceOf(e);

  return (
    <article
      id={evidenceDomId(e.id)}
      tabIndex={0}
      aria-label={`Evidence ${e.id}: ${e.title}`}
      {...hover({ ev: e.id, frags: [] })}
      className={cx(
        'flex scroll-mt-4 flex-col gap-[9px] rounded-2xl border bg-surface px-4 pb-3.5 pt-3 transition-[border-color,box-shadow] duration-fast',
        on ? 'border-acc shadow-ring' : 'border-line',
      )}
    >
      {/* Wraps instead of squeezing: the title keeps at least 12rem, badges move to their own line when they do not
          fit, and a badge longer than the card is truncated with its full text in the tooltip. */}
      <div className="flex flex-wrap items-center gap-x-[9px] gap-y-1.5">
        <EvidenceTag id={e.id} />
        <span className="min-w-[12rem] flex-1 text-[14px] font-semibold">{e.title}</span>
        {contradictionOpen && (
          <span className="inline-flex items-center gap-[5px] rounded-sm bg-warn-soft px-[7px] py-0.5 text-[11.5px] font-medium text-warn">
            <span aria-hidden="true" className="h-1.5 w-1.5 rotate-45 bg-warn" />
            {contradictionLabel}
          </span>
        )}
        <span
          data-testid="source-label"
          title={e.sourceLabel?.title ?? prov.text}
          className={cx('max-w-full truncate whitespace-nowrap rounded-sm px-[7px] py-0.5 text-[11.5px] font-medium', PROVENANCE_CLASS[prov.kind])}
        >
          {prov.text}
        </span>
        <span className={cx('text-[12px]', used ? 'text-ink-2' : 'text-ink-3')}>
          {usedText(used, e.caption)}
        </span>
        {actions}
      </div>

      {e.meta && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-ink-2">
          <span>{e.meta.type}</span>
          <span className="flex items-center gap-[5px]">
            <span className="rounded-xs border border-line-2 px-1 py-[3px] font-mono text-mono-tag">{e.meta.tag}</span>
            {e.meta.source}
          </span>
          <span>Received {e.meta.received}</span>
          {e.meta.hash && <span className="font-mono text-[11px] leading-[1.4] text-ink-3">sha256 {e.meta.hash}</span>}
        </div>
      )}

      {e.warning && (
        <div role="note" className="flex items-center gap-2 rounded-lg border border-info-line bg-info-soft px-2.5 py-[7px] text-[12.5px] text-info">
          <span aria-hidden="true" className="font-mono text-[11px] font-semibold leading-none">
            i
          </span>
          {e.warning}
        </div>
      )}

      {b.kind === 'lines' && <SourceLines id={e.id} lines={b.lines} hl={hl} />}

      {b.kind === 'mandate' && (
        <>
          <div className="text-heading-md font-medium leading-[1.4]">
            {b.headline} <span className="font-mono text-[14px]">{b.sessionId}</span>
          </div>
          <KeyValues id={e.id} rows={b.rows} hl={hl} />
        </>
      )}

      {b.kind === 'receipt' && <ReceiptGrid id={e.id} calls={b.calls} currency={b.currency} cap={b.cap} hl={hl} />}

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
              className="h-2 overflow-hidden rounded-sm bg-line"
            >
              <span className="block h-full bg-acc" style={{ width: `${(Number(b.captured) / Number(b.cap)) * 100}%` }} />
            </div>
            <div className="flex justify-between font-mono text-caption font-medium leading-none text-ink-2">
              <span>{b.captured} captured</span>
              <span className="text-ink-3">
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
