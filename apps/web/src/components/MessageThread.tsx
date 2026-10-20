import { utcStamp } from '../domain/time';
import type { DisputeMessage } from '../domain/types';

/** Who wrote a message, as the seller reads it: «Buyer», «You» (the seller), or PayPal's code. */
function author(postedBy: string): string {
  if (postedBy === 'BUYER') return 'Buyer';
  if (postedBy === 'SELLER') return 'You';
  return postedBy;
}

function when(time: string | null): string {
  const t = time ? new Date(time) : null;
  return t && !Number.isNaN(t.getTime()) ? utcStamp(t) : 'time not given';
}

/**
 * The dispute's thread from the latest PayPal (or simulator) read. Shown to the seller's workspace only: never stored,
 * never given to the analyst ([A5]).
 */
export function MessageThread({ messages, title = 'Messages' }: { messages: readonly DisputeMessage[] | undefined; title?: string }) {
  const list = messages ?? [];
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        <span className="text-[11.5px] text-ink-3">From PayPal’s thread · not stored</span>
      </div>
      {list.length === 0 ? (
        <p className="m-0 text-[12.5px] text-ink-3">No messages on this dispute yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {list.map((m, i) => (
            <li key={`${m.postedBy}|${m.time ?? ''}|${i}`} className={m.postedBy === 'SELLER' ? 'rounded-lg bg-acc-soft px-3 py-2' : 'rounded-lg border border-line px-3 py-2'}>
              <div className="flex flex-wrap items-baseline gap-x-2 text-[11.5px] text-ink-3">
                <strong className="text-[12px] font-semibold text-ink">{author(m.postedBy)}</strong>
                <span className="font-mono">{when(m.time)}</span>
                {m.files.length > 0 && <span>· {m.files.join(', ')}</span>}
              </div>
              <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-normal text-ink [overflow-wrap:anywhere]">{m.content}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
