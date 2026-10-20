import { CONTRACTS, statusLabel } from '../domain/actionContracts';
import { ACTION_TEXT_LIMIT, type ActionAvailability, type IntentAction } from '../domain/actions';
import { formatCount } from '../domain/draft';
import { ACTION_LABEL } from '../domain/status';
import { PrimaryAction, cx } from './ui';

const VARIANT_LABEL: Partial<Record<string, string>> = { send_message: 'Message' };

/**
 * An action other than evidence, as the merchant writes it: for a message, the text with its `n / 2,000` count; for
 * every action, whether PayPal offers it now and each variant's status as the contract registry gives it
 * («Tested locally», «Not available: <reason>»). Only a sendable message can be reviewed.
 */
export function ActionComposer({
  action,
  text,
  onText,
  availability,
  locked,
  onReview,
}: {
  action: Exclude<IntentAction, 'provide_evidence'>;
  text: string;
  onText: (t: string) => void;
  availability: ActionAvailability;
  /** Why this person cannot send it here (signed out, another workspace), or null. */
  locked: string | null;
  onReview: () => void;
}) {
  const isMessage = action === 'send_message';
  const len = text.trim().length;
  const over = len > ACTION_TEXT_LIMIT;
  const canReview = isMessage && availability.sendable && !locked && len > 0 && !over;
  const label = ACTION_LABEL[action];
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="m-0 text-[12.5px] font-semibold">{label}</h3>
      <ul aria-label={`${label}: availability`} className="m-0 flex list-none flex-col gap-1 p-0 text-[11.5px]">
        {/* The composer cannot attach an upload yet: the file variant (tested on the server) is not offered here. */}
        {availability.variants.filter((v) => v.variant !== 'send_message:file').map((v) => (
          <li key={`${v.variant}|${v.type}`} className={v.available ? 'text-ok' : 'text-ink-3'}>
            {(v.variant && VARIANT_LABEL[v.variant]) ?? v.type ?? label} · {v.variant ? statusLabel(CONTRACTS[v.variant]) : `Not available: ${v.why ?? ''}`}
          </li>
        ))}
      </ul>
      {!availability.sendable && availability.why && (
        <p role="note" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          Not available: {availability.why}
        </p>
      )}
      {isMessage && (
        <>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-[12.5px]">
              <span className="font-medium">Message to the buyer</span>
              <span className={cx('font-mono text-[12px]', over ? 'text-bad' : 'text-ink-2')}>
                {`${formatCount(len)} / ${formatCount(ACTION_TEXT_LIMIT)}`}
              </span>
            </span>
            <textarea
              aria-label="Message to the buyer"
              value={text}
              onChange={(e) => onText(e.target.value)}
              rows={5}
              disabled={!availability.sendable}
              className="resize-y rounded-[7px] border border-line-2 bg-surface px-2.5 py-2 text-body leading-normal text-ink disabled:opacity-60"
            />
          </label>
          <span className="text-[11.5px] text-ink-3">The buyer sees exactly this text in PayPal. You review it before it is sent.</span>
          {locked && <span className="text-[12px] text-warn">{locked}</span>}
          <PrimaryAction enabled={canReview} onClick={onReview}>
            Review the message →
          </PrimaryAction>
        </>
      )}
    </section>
  );
}
