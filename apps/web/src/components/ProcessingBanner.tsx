import { ACTION_LABEL } from '../domain/status';
import type { ActionCode } from '../domain/types';
import { PollCountdown } from './SyncIndicator';
import { Spinner } from './ui';

const EXPECTED: ActionCode[] = ['provide_evidence', 'send_message', 'make_offer'];

/**
 * A new dispute first shows UNDER_REVIEW with no seller actions (docs/sandbox-findings.md). Nothing can
 * be sent until PayPal opens it; we keep polling and show which actions are not available yet.
 */
export function ProcessingBanner({ checkedAt, allowedActions }: { checkedAt: number | null; allowedActions: readonly ActionCode[] }) {
  return (
    <div role="status" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 bg-info-soft px-[22px] py-3.5">
      <Spinner tone="info" slow />
      <div className="flex flex-col gap-0.5">
        <strong className="text-[14.5px] font-semibold">PayPal is processing this new dispute. Actions appear shortly.</strong>
        <span className="text-[13px] text-ink2">
          New disputes stay in this state for a few minutes before PayPal opens them to you. Meanwhile the analyst is reading documents. Nothing can
          be sent until PayPal opens the dispute.
        </span>
      </div>
      <div className="flex flex-col items-end gap-[5px]">
        <PollCountdown checkedAt={checkedAt} />
        <span className="flex gap-[5px]" aria-label="Actions not available yet">
          {EXPECTED.map((a) => (
            <span key={a} className="rounded border border-dashed border-line2 px-2 py-[3px] text-[11.5px] text-ink3">
              {ACTION_LABEL[a]}
            </span>
          ))}
        </span>
        <span className="text-[11.5px] text-ink3">
          {allowedActions.length ? `PayPal now allows ${allowedActions.length} actions` : 'No actions allowed by PayPal yet'}
        </span>
      </div>
    </div>
  );
}
