import { useMemo, useState } from 'react';
import { useServices } from '../app/services';
import { canFindDisputes, scanErrorText, scanResultText } from '../domain/discovered';
import { HttpDisputeGateway, type ScanResult } from '../domain/httpGateway';
import { cx } from './ui';

/**
 * «Find new disputes»: the evaluation workspace's owner asks the server to look at PayPal for disputes needing the
 * seller that came from a ResolveKit order and are not cases yet (the fallback when a webhook does not arrive). Shows
 * «Found N new · M skipped» with why each was skipped on hover; the cases it made appear once health is read again.
 * Nothing renders for anyone else.
 */
export function FindNewDisputes({ scan }: { scan?: () => Promise<ScanResult> }) {
  const { area, demo, retryHealth } = useServices();
  const server = useMemo(() => (scan ? null : new HttpDisputeGateway()), [scan]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; title: string | null; bad: boolean } | null>(null);
  if (!canFindDisputes(area, demo)) return null;

  const run = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await (scan ? scan() : server!.scan());
      setSaid({ ...scanResultText(r), bad: false });
      if (r.created.length) retryHealth();
    } catch (e) {
      setSaid({ text: scanErrorText(e), title: null, bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        title="Look at PayPal now for new disputes from ResolveKit orders (owner only)"
        className="h-8 rounded-[7px] border border-line-2 bg-surface px-[11px] text-[12.5px] text-ink-2 disabled:opacity-60"
      >
        {busy ? 'Looking for new disputes…' : 'Find new disputes'}
      </button>
      <span aria-live="polite" title={said?.title ?? undefined} className={cx('text-[12px]', said?.bad ? 'text-bad' : 'text-ink-2', said?.title && 'cursor-help underline decoration-dotted')}>
        {said?.text}
      </span>
    </span>
  );
}
