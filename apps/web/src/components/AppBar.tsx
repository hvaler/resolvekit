import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useServices } from '../app/services';
import { useTheme } from '../theme/ThemeProvider';
import { AccountMenu } from './AccountMenu';
import { SyncIndicator } from './SyncIndicator';
import { cx } from './ui';

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 text-ink no-underline hover:text-ink" aria-label="ResolveKit, all cases">
      <span aria-hidden="true" className="relative box-border block h-[17px] w-[17px] rounded-md border-2 border-acc">
        <span className="absolute bottom-0.5 right-0.5 h-[5px] w-[5px] rounded-[1px] bg-acc" />
      </span>
      <span className="text-[14.5px] font-semibold leading-none tracking-[-0.01em]">
        Resolve<span className="font-normal text-ink-2">Kit</span>
      </span>
    </Link>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-line-2 bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            'rounded-sm px-2 py-0.5 text-[11.5px]',
            value === o.v ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.12)]' : 'text-ink-2',
          )}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function ThemeControls() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <div className="flex items-center gap-1.5">
      <Segmented
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { v: 'light', l: 'Light' },
          { v: 'dark', l: 'Dark' },
        ]}
      />
      <Segmented
        label="Accent colour"
        value={accent}
        onChange={setAccent}
        options={[
          { v: 'teal', l: 'Teal' },
          { v: 'indigo', l: 'Indigo' },
        ]}
      />
    </div>
  );
}

/**
 * Which PayPal is behind what is on screen, always visible: real PayPal (sandbox or live) for a case bound to a real
 * dispute while the server reports PayPal connected, otherwise the in-browser simulator.
 */
export function ModeBadge({ caseId }: { caseId?: string }) {
  const { modeOf, health, snapshots } = useServices();
  const origin = caseId ? snapshots[caseId]?.origin : undefined;
  const disputeId = origin?.kind === 'paypal' ? origin.disputeId : null;
  const bound = health?.bound.length ?? 0;
  if (caseId) {
    const m = modeOf(caseId);
    if (m.kind === 'paypal') {
      return (
        <span
          data-testid="mode-badge"
          title={`This case reads and writes the real PayPal ${m.env} dispute${disputeId ? ` ${disputeId}` : ''} through the ResolveKit server. Case documents are synthetic.`}
          className="flex items-center gap-1.5 rounded-md border border-ok-line bg-ok-soft px-2 py-1 text-[11.5px] font-medium text-ok"
        >
          <span aria-hidden="true" className="h-[7px] w-[7px] rounded-full bg-ok" />
          PayPal {m.env} · live{disputeId ? <span className="font-mono font-normal"> {disputeId}</span> : null}
        </span>
      );
    }
  }
  return (
    <span
      data-testid="mode-badge"
      title={
        caseId
          ? 'This case runs on the in-browser PayPal simulator: nothing is sent to PayPal. All data is synthetic.'
          : `Cases run on the in-browser PayPal simulator${bound ? `, except ${bound} bound to a real PayPal ${health?.paypal} dispute` : ''}. All data is synthetic.`
      }
      className="flex items-center gap-1.5 rounded-md border border-dashed border-info-line bg-info-soft px-2 py-1 text-[11.5px] font-medium text-info"
    >
      <span aria-hidden="true" className="h-[5px] w-[5px] rotate-45 border-[1.5px] border-info" />
      Simulated PayPal{!caseId && bound ? ` · ${bound} case${bound > 1 ? 's' : ''} on PayPal ${health?.paypal}` : ''}
    </span>
  );
}

/** The merchant in local mode (no sign-in): the operator at this machine. Hosted mode names the signed-in person. */
export const MERCHANT = { name: 'Alex Moreno', initials: 'AM' } as const;

export function AppBar({
  caseId,
  badge,
  checkedAt,
  onSync,
  syncNow = false,
}: {
  caseId?: string;
  badge?: ReactNode;
  checkedAt: number | null;
  /** Read from PayPal now: used by Retry when a read failed, and by "Sync now". */
  onSync?: () => void;
  /** Show a "Sync now" button next to the sync status (inbox). */
  syncNow?: boolean;
}) {
  return (
    <header className="flex h-11 flex-none items-center gap-3.5 border-b border-line bg-surface px-[18px] max-md:h-auto max-md:flex-wrap max-md:gap-x-2.5 max-md:gap-y-2 max-md:px-4 max-md:py-2">
      <Logo />
      <span aria-hidden="true" className="h-[18px] w-px bg-line-2" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-3.5 max-md:gap-2">
        {caseId ? (
          <>
            <Link to="/" className="text-[12.5px] text-ink-2 no-underline hover:text-ink">
              Cases
            </Link>
            <span aria-hidden="true" className="text-ink-3">
              /
            </span>
            <span aria-current="page" className="font-mono text-mono-id leading-none">
              {caseId}
            </span>
            {badge}
          </>
        ) : (
          <span aria-current="page" className="text-[12.5px] font-medium">
            Cases
          </span>
        )}
      </nav>
      <span className="flex-1 max-md:basis-full max-md:flex-none" />
      <SyncIndicator checkedAt={checkedAt} onRetry={onSync} />
      {syncNow && onSync && (
        <button type="button" onClick={onSync} className="h-[26px] rounded-md border border-line-2 bg-surface px-[9px] text-[12px] text-ink-2">
          Sync now
        </button>
      )}
      <ModeBadge caseId={caseId} />
      <ThemeControls />
      <AccountMenu fallback={MERCHANT} />
    </header>
  );
}
