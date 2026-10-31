import { useState } from 'react';
import { useServices } from '../app/services';
import { anotherAccountHelp } from '../domain/copy';
import { signOutDestination } from '../domain/environment';

/** Why «Use another PayPal account» can bring the same account back, and what to do (sign out of PayPal, or a private window). */
export function AnotherAccountHelp({ env }: { env: 'sandbox' | 'live' | 'unconfigured' | null | undefined }) {
  const h = anotherAccountHelp(env);
  const [before, after] = h.text.split('Sign out of PayPal');
  return (
    <span data-testid="another-account-help" className="basis-full text-[12px] leading-normal text-ink-3">
      {h.url ? (
        <>
          {before}
          <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-ink-2 underline">
            Sign out of PayPal
          </a>
          {after}
        </>
      ) : (
        h.text
      )}
    </span>
  );
}

/** Sign out, and sign out to start a fresh PayPal sign-in; a failure keeps the person here with a visible line. */
export function SignOutActions({ everywhere = false, anotherHelp = false }: { everywhere?: boolean; /** Say how to really get another account. */ anotherHelp?: boolean }) {
  const { signOut, health } = useServices();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async (all: boolean, another: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      await signOut(all, signOutDestination(another));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run(false, false)} className="h-8 self-start rounded-md border border-line-2 bg-surface px-3 text-[12.5px] text-ink disabled:opacity-60">
        Sign out
      </button>
      {everywhere && (
        <button type="button" disabled={busy} onClick={() => void run(true, false)} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
          Sign out of all devices
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => void run(false, true)} className="self-start border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
        Use another PayPal account
      </button>
      {anotherHelp && <AnotherAccountHelp env={health?.paypal ?? null} />}
      {failed && (
        <span role="alert" className="text-[12px] text-bad">
          Couldn&apos;t sign out. Try again.
        </span>
      )}
    </>
  );
}
