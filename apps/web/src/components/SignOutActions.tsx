import { useState } from 'react';
import { useServices } from '../app/services';
import { signOutDestination } from '../domain/environment';

/** Sign out, and sign out to start a fresh PayPal sign-in; a failure keeps the person here with a visible line. */
export function SignOutActions({ everywhere = false }: { everywhere?: boolean }) {
  const { signOut } = useServices();
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
      {failed && (
        <span role="alert" className="text-[12px] text-bad">
          Couldn&apos;t sign out. Try again.
        </span>
      )}
    </>
  );
}
