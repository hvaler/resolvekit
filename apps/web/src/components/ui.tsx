import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../domain/status';

/** Colour tokens per tone. Colour is never the only signal: every use pairs it with text or an icon. */
export const TONE_FG: Record<Tone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  info: 'var(--info)',
  acc: 'var(--acc)',
  muted: 'var(--ink3)',
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Small monospace code shown next to a human label (PayPal codes). */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-mono-code font-normal text-ink-3', className)}>{children}</span>;
}

/** Evidence id tag: "E3". */
export function EvidenceTag({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cx(
        'flex-none bg-acc-soft font-mono font-semibold leading-none text-acc',
        size === 'md' ? 'rounded-sm px-1.5 py-1 text-[11px]' : 'rounded-xs px-[5px] py-[3px] text-[10.5px]',
      )}
    >
      {id}
    </span>
  );
}

export function Spinner({ size = 20, tone = 'acc', slow = false }: { size?: number; tone?: 'acc' | 'info'; slow?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx('box-border inline-block flex-none rounded-full', slow ? 'animate-spin-slow' : 'animate-spin')}
      style={{
        width: size,
        height: size,
        border: `2.5px solid ${tone === 'info' ? 'var(--info-line)' : 'var(--line2)'}`,
        borderTopColor: tone === 'info' ? 'var(--info)' : 'var(--acc)',
      }}
    />
  );
}

type ButtonVariant = 'primary' | 'secondary';

export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const v: Record<ButtonVariant, string> = {
    primary: 'border-0 bg-acc px-[18px] font-semibold text-acc-ink',
    secondary: 'border border-line-2 bg-surface px-4 font-medium',
  };
  return <button type="button" className={cx('h-10 rounded-xl text-[13.5px] disabled:cursor-not-allowed', v[variant], className)} {...rest} />;
}

/** The main call-to-action at the bottom of a composer: accent when enabled, muted when not. */
export function PrimaryAction({
  enabled,
  onClick,
  children,
  className,
}: {
  enabled: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        'h-[42px] rounded-xl border-0 text-[14px] font-semibold transition-[background] duration-base',
        enabled ? 'cursor-pointer bg-acc text-acc-ink' : 'cursor-not-allowed bg-line text-ink-3',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Small bordered secondary button used inside cards (contradiction actions, edit, preview…). */
export function MiniButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx('rounded-md border border-line-2 bg-surface px-[9px] py-[5px] text-[12px] text-ink-2 disabled:cursor-not-allowed', className)}
      {...rest}
    />
  );
}
