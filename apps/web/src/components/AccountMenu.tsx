import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useServices } from '../app/services';
import { initials, roleLabel } from '../domain/demoClient';
import { EnvironmentsHelp } from './EnvironmentsHelp';
import { cx } from './ui';

/** Where a signed-out visitor is sent to sign in (the page they were on comes back after a passkey sign-in). */
export function signInHref(): string {
  if (typeof window === 'undefined') return '/signin';
  const here = window.location.pathname + window.location.search;
  return here === '/' || here.startsWith('/signin') ? '/signin' : `/signin?next=${encodeURIComponent(here)}`;
}

/** An action that needs someone else: why, and the way to sign in (shown where the action is offered). */
export function SignInPrompt({ reason, signedIn }: { reason: string; signedIn: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body leading-normal text-ink-2">
      <span>{reason}</span>
      {!signedIn && (
        <Link to={signInHref()} className="font-semibold text-acc">
          Sign in
        </Link>
      )}
    </span>
  );
}

/** The role chip next to a person's name. */
export function RoleChip({ role, reviewer }: { role: 'owner' | 'member'; reviewer: boolean }) {
  const label = roleLabel({ role, reviewer });
  return (
    <span className={cx('rounded-sm border px-[5px] py-px text-[10.5px] font-semibold uppercase tracking-[.04em]', role === 'owner' ? 'border-acc-line bg-acc-soft text-acc' : 'border-line-2 bg-surface-2 text-ink-2')}>
      {label}
    </span>
  );
}

const CONNECTION_TEXT: Record<'evaluation' | 'not_connected' | 'checking', string> = {
  evaluation: 'Sandbox evaluation: this workspace’s PayPal account is the seller on the bound sandbox disputes. Test documents go to PayPal sandbox disputes; no real money moves.',
  not_connected: 'This workspace isn’t connected to its PayPal disputes yet. Explore demo shows the full flow on fictional cases.',
  checking: 'Checking this workspace’s PayPal connection…',
};

const VIA: Record<string, string> = { paypal: 'PayPal', passkey: 'passkey', browser: 'this browser only' };

/** "15 Dec 2026" (UTC). */
export function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * App bar: on the hosted demo, "Sign in" for visitors, or who is signed in for which workspace, with the account menu.
 * Local mode (no sign-in) shows the local merchant avatar instead.
 */
export function AccountMenu({ fallback }: { fallback: { name: string; initials: string } }) {
  const { demo, signOut } = useServices();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!demo) {
    return (
      <span role="img" aria-label={fallback.name} className="grid h-[26px] w-[26px] place-items-center rounded-full bg-acc-soft text-[10.5px] font-semibold text-acc">
        {fallback.initials}
      </span>
    );
  }
  if (!demo.signedIn || !demo.person || !demo.workspace) {
    return (
      <Link to={signInHref()} data-testid="sign-in" className="flex h-[26px] items-center rounded-md border-0 bg-acc px-2.5 text-[12px] font-semibold text-acc-ink no-underline">
        Sign in
      </Link>
    );
  }
  const p = demo.person;
  /** Sign out, then start a fresh PayPal sign-in (signOut reloads to `/`, so the page change happens first). */
  const useAnother = async () => {
    await signOut(false);
    window.location.assign('/signin');
  };
  const ws = demo.workspace;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid="account-menu"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="flex h-[28px] items-center gap-2 rounded-md border border-line-2 bg-surface py-0 pl-1 pr-2 text-[12px]"
      >
        <span aria-hidden="true" className="grid h-[22px] w-[22px] place-items-center rounded-full bg-acc-soft text-[10px] font-semibold text-acc">
          {initials(p.name)}
        </span>
        <span className="max-w-[160px] truncate font-medium max-md:hidden">{ws.name}</span>
        <RoleChip role={p.role} reviewer={p.reviewer} />
      </button>
      {open && (
        <div role="dialog" aria-label="Account" className="absolute right-0 top-[34px] z-50 flex w-[300px] flex-col gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-float">
          <div className="flex flex-col gap-0.5">
            <strong className="text-[13.5px] font-semibold">{p.name}</strong>
            <span className="text-[12px] text-ink-2">
              {roleLabel(p)} of {ws.name} · signed in with {VIA[p.via] ?? p.via}
            </span>
            {p.email && <span className="font-mono text-[11.5px] text-ink-3">{p.email}</span>}
          </div>
          <div className={cx('rounded-lg border px-2.5 py-2 text-[12px] leading-normal', ws.connection === 'evaluation' ? 'border-ok-line bg-ok-soft text-ok' : 'border-line-2 bg-surface-2 text-ink-2')}>
            {CONNECTION_TEXT[ws.connection]}
          </div>
          {p.accessUntil && <span className="text-[12px] text-ink-2">Reviewer access until {dateText(p.accessUntil)}.</span>}
          <div className="flex flex-col gap-1.5">
            {p.role === 'owner' && (
              <Link to="/workspace" onClick={() => setOpen(false)} className="text-[12.5px] font-medium text-acc">
                Members and invites
              </Link>
            )}
            <Link to="/demo" onClick={() => setOpen(false)} className="text-[12.5px] font-medium text-acc">
              Explore demo
            </Link>
            <button type="button" onClick={() => void signOut(false)} className="h-8 self-start rounded-md border border-line-2 bg-surface px-3 text-[12.5px] text-ink">
              Sign out
            </button>
            <button type="button" onClick={() => void signOut(true)} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
              Sign out of all devices
            </button>
            <button type="button" onClick={() => void useAnother()} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
              Use another PayPal account
            </button>
            <details className="text-[12px] text-ink-2">
              <summary className="cursor-pointer">The three environments</summary>
              <EnvironmentsHelp className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0 text-[12px] leading-normal text-ink-2" />
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
