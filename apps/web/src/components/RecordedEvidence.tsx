import { EVIDENCE_TYPE_LABEL } from '../domain/evidenceTypes';
import { formatCount } from '../domain/draft';
import { outcomeText } from '../domain/inbox';
import { sellerEvidence } from '../domain/recorded';
import type { DisputeSnapshot, EvidenceType } from '../domain/types';
import { utcStamp } from '../domain/time';

const typeLabel = (t: string) => (t in EVIDENCE_TYPE_LABEL ? EVIDENCE_TYPE_LABEL[t as EvidenceType] : t);

/**
 * What PayPal holds for this dispute, read back: the outcome once it is closed, and the seller's evidence exactly as
 * PayPal (or the simulator) stored it. Shown instead of the editable draft controls once the evidence is in.
 */
export function RecordedEvidence({ snapshot, realPayPal }: { snapshot: DisputeSnapshot; realPayPal: boolean }) {
  const entries = sellerEvidence(snapshot);
  const e = entries[entries.length - 1];
  const by = realPayPal ? 'PayPal' : 'the simulator';
  const resolved = snapshot.status === 'RESOLVED';
  const won = snapshot.outcome?.code === 'RESOLVED_SELLER_FAVOUR';
  const closedAt = snapshot.outcome?.closedAt ? utcStamp(new Date(snapshot.outcome.closedAt)).replace(/:\d\d UTC$/, ' UTC') : null;
  return (
    <section aria-label={`Recorded by ${by}`} className="flex flex-col gap-2">
      {resolved && (
        <p
          role="status"
          className={
            won
              ? 'm-0 rounded-lg border border-ok-line bg-ok-soft px-3 py-2.5 text-[13px] text-ink'
              : 'm-0 rounded-lg border border-line-2 bg-surface-2 px-3 py-2.5 text-[13px] text-ink'
          }
        >
          <strong className="font-semibold">{outcomeText(snapshot.outcome?.code)}</strong>
          {closedAt ? ` · ${closedAt}` : ''}
          <span className="mt-0.5 block text-[12px] text-ink-2">
            {by === 'PayPal' ? 'PayPal' : 'The simulated PayPal'} closed this dispute
            {snapshot.outcome?.code ? (
              <>
                {' '}
                (<span className="font-mono text-[10.5px]">{snapshot.outcome.code}</span>)
              </>
            ) : null}
            . Nothing is left to do; the case file stays here read-only.
          </span>
        </p>
      )}
      {e ? (
        <>
          <h3 className="m-0 text-[12.5px] font-semibold">
            {`Recorded by ${by}`} <span className="font-normal text-ink-3">· {e.storedAt}</span>
          </h3>
          <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-xl border border-line px-3 py-2.5 text-[12.5px]">
            <dt className="text-ink-3">Evidence type</dt>
            <dd className="m-0">
              {typeLabel(e.evidenceType)} <span className="font-mono text-[10.5px] text-ink-3">{e.evidenceType}</span>
            </dd>
            {(e.carrier || e.tracking) && (
              <>
                <dt className="text-ink-3">Tracking</dt>
                <dd className="m-0 font-mono text-[12px] [overflow-wrap:anywhere]">
                  {e.carrier} · {e.tracking}
                </dd>
              </>
            )}
            <dt className="text-ink-3">Files</dt>
            <dd className="m-0 flex flex-col gap-0.5 font-mono text-[11.5px] [overflow-wrap:anywhere]">
              {e.files.length ? e.files.map((f) => <span key={f}>{f}</span>) : <span className="font-sans text-ink-3">None</span>}
            </dd>
            <dt className="text-ink-3">Notes</dt>
            <dd className="m-0 flex flex-col gap-1">
              <span className="text-[11.5px] text-ink-3">{formatCount(e.notes.length)} characters, as stored</span>
              <span className="whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 text-[12.5px] leading-[1.5] text-ink-2">{e.notes}</span>
            </dd>
          </dl>
          <span className="text-[11.5px] text-ink-3">
            Read back from {by}. The draft below is the analysis it was built from: supported sentences went as the notes, removed ones were never sent.
          </span>
        </>
      ) : (
        <p className="m-0 text-[12.5px] text-ink-3">{by === 'PayPal' ? 'PayPal' : 'The simulator'} shows no seller evidence on this dispute.</p>
      )}
    </section>
  );
}
