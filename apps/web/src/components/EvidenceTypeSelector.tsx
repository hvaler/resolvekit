import { EVIDENCE_TYPE_LABEL, type EvidenceTypeOption } from '../domain/evidenceTypes';
import type { EvidenceType } from '../domain/types';

/**
 * "PayPal is asking for…" plus the type choice. A type PayPal rejects stays visible but disabled, with
 * PayPal's reason, so the merchant sees why it is not offered.
 */
export function EvidenceTypeSelector({
  options,
  selected,
  onSelect,
  requested,
  requestedNote,
}: {
  options: EvidenceTypeOption[];
  selected: EvidenceType | null;
  onSelect: (t: EvidenceType) => void;
  requested: EvidenceType;
  requestedNote: string;
}) {
  return (
    <section aria-label="Evidence type" className="flex flex-col gap-[7px]">
      <h3 className="m-0 text-[12.5px] font-semibold">Evidence type</h3>
      <div className="flex flex-wrap items-center gap-2 rounded-[7px] border border-info-line bg-info-soft px-[11px] py-2 text-[12.5px]">
        <span className="text-info">PayPal is asking for:</span>
        <strong className="font-semibold">{EVIDENCE_TYPE_LABEL[requested]}</strong>
        <span className="font-mono text-[10px] leading-[1.2] text-ink3">{requested}</span>
        <span className="flex-1" />
        <span className="text-[11.5px] text-ink3">{requestedNote}</span>
      </div>
      <div role="radiogroup" aria-label="Evidence type to send" className="flex flex-col gap-1.5">
        {options.map((o) => {
          const sel = o.type === selected && o.allowed;
          const dis = !o.allowed;
          const fit = o.allowed && o.satisfied && o.requested;
          return (
            <button
              key={o.type}
              type="button"
              role="radio"
              aria-checked={sel}
              aria-disabled={dis}
              onClick={() => !dis && onSelect(o.type)}
              className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 rounded-lg px-3 py-2 text-left"
              style={{
                border: `1px ${dis ? 'dashed' : 'solid'} ${dis ? 'var(--line2)' : sel ? 'var(--acc)' : 'var(--line2)'}`,
                background: dis ? 'var(--surface2)' : sel ? 'var(--acc-soft)' : 'var(--surface)',
                color: dis ? 'var(--ink3)' : 'var(--ink)',
                cursor: dis ? 'not-allowed' : 'pointer',
              }}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 box-border grid h-3.5 w-3.5 place-items-center rounded-full"
                style={{ border: `1.5px solid ${sel ? 'var(--acc)' : 'var(--line2)'}` }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: sel ? 'var(--acc)' : 'transparent' }} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[13px] font-medium">{o.label}</span>
                  <span className="font-mono text-[10px] leading-[1.2] text-ink3">{o.type}</span>
                </span>
                <span className="text-[12px]" style={{ color: fit ? 'var(--ok)' : dis ? 'var(--bad)' : 'var(--ink3)' }}>
                  {o.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
