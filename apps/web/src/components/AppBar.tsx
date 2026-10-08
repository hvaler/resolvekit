import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../theme/ThemeProvider';
import { SyncIndicator } from './SyncIndicator';
import { cx } from './ui';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 text-ink no-underline hover:text-ink" aria-label="ResolveKit, all cases">
      <span aria-hidden="true" className="relative box-border block h-[17px] w-[17px] rounded-[5px] border-2 border-acc">
        <span className="absolute bottom-0.5 right-0.5 h-[5px] w-[5px] rounded-[1px] bg-acc" />
      </span>
      <span className="text-[14.5px] font-semibold leading-none tracking-[-0.01em]">
        Resolve<span className="font-normal text-ink2">Kit</span>
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
    <div role="radiogroup" aria-label={label} className="flex rounded-md border border-line2 bg-surface2 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          onClick={() => onChange(o.v)}
          className={cx(
            'rounded px-2 py-0.5 text-[11.5px]',
            value === o.v ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,.12)]' : 'text-ink2',
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

export const MERCHANT = { name: 'Alex Moreno', initials: 'AM' } as const;

export function AppBar({ caseId, badge, checkedAt }: { caseId?: string; badge?: ReactNode; checkedAt: number | null }) {
  return (
    <header className="flex h-11 flex-none items-center gap-3.5 border-b border-line bg-surface px-[18px]">
      <Logo />
      <span aria-hidden="true" className="h-[18px] w-px bg-line2" />
      <nav aria-label="Breadcrumb" className="flex items-center gap-3.5">
        {caseId ? (
          <>
            <Link to="/" className="text-[12.5px] text-ink2 no-underline hover:text-ink">
              Cases
            </Link>
            <span aria-hidden="true" className="text-ink3">
              /
            </span>
            <span aria-current="page" className="font-mono text-[12.5px] font-medium leading-none">
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
      <span className="flex-1" />
      <SyncIndicator checkedAt={checkedAt} />
      <span
        title="Connected to the PayPal sandbox. All data is synthetic."
        className="flex items-center gap-1.5 rounded-[5px] border border-dashed border-info-line bg-info-soft px-2 py-1 text-[11.5px] font-medium text-info"
      >
        <span aria-hidden="true" className="h-[5px] w-[5px] rotate-45 border-[1.5px] border-info" />
        Sandbox · synthetic data
      </span>
      <ThemeControls />
      <span role="img" aria-label={MERCHANT.name} className="grid h-[26px] w-[26px] place-items-center rounded-full bg-acc-soft text-[10.5px] font-semibold text-acc">
        {MERCHANT.initials}
      </span>
    </header>
  );
}
