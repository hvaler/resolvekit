import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useServices } from '../app/services';
import { cx } from './ui';

/** Code entry: used in the app bar popover and wherever a locked action is offered (approve flow). */
export function DemoUnlockForm({ onDone, autoFocus = false, compact = false }: { onDone?: () => void; autoFocus?: boolean; compact?: boolean }) {
  const { unlockDemo } = useServices();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await unlockDemo(code.trim());
    setBusy(false);
    if (r.ok) {
      setCode('');
      onDone?.();
    } else setError(r.error);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" aria-label="Unlock demo actions">
      <label htmlFor={id} className={cx('text-[12px] text-ink-2', compact && 'sr-only')}>
        Demo code (from the Devpost testing instructions)
      </label>
      <div className="flex gap-1.5">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Demo code"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          className="h-8 min-w-0 flex-1 rounded-md border border-line-2 bg-surface px-2 font-mono text-[12.5px] text-ink"
        />
        <button type="submit" disabled={!code.trim() || busy} className="h-8 rounded-md border-0 bg-acc px-3 text-[12.5px] font-semibold text-acc-ink disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
      {error && (
        <span id={`${id}-err`} role="alert" className="text-[12px] text-bad">
          {error}
        </span>
      )}
    </form>
  );
}

/**
 * App bar control on the hosted demo: browsing is free; sending evidence to real PayPal and live AI runs need the demo
 * code. Hidden when the server has no lock (local mode).
 */
export function DemoUnlock() {
  const { demo, lockDemo } = useServices();
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
  if (!demo) return null;
  const until = demo.expiresAt ? new Date(demo.expiresAt).toISOString().slice(11, 16) : null;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid="demo-unlock"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={demo.unlocked ? `Demo actions unlocked${until ? ` until ${until} UTC` : ''}` : 'Sending evidence to real PayPal and live AI runs need the demo code'}
        className={cx(
          'flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium',
          demo.unlocked ? 'border-ok-line bg-ok-soft text-ok' : 'border-line-2 bg-surface text-ink-2',
        )}
      >
        <span aria-hidden="true" className="relative box-border inline-block h-[9px] w-[9px] rounded-[2px] border-[1.5px] border-current">
          <span className={cx('absolute -top-[5px] left-[0.5px] h-[5px] w-[5px] rounded-t-full border-[1.5px] border-b-0 border-current', demo.unlocked && '-translate-x-[3px]')} />
        </span>
        {demo.unlocked ? 'Demo actions unlocked' : 'Unlock demo actions'}
      </button>
      {open && (
        <div role="dialog" aria-label="Demo actions" className="absolute right-0 top-[32px] z-50 flex w-[300px] flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 shadow-float">
          {demo.unlocked ? (
            <>
              <span className="text-[12.5px] leading-normal text-ink-2">
                Unlocked{until ? ` until ${until} UTC` : ''}: you can send evidence to the real PayPal sandbox and run the AI live. Daily limits apply to everyone.
              </span>
              <button type="button" onClick={() => void lockDemo().then(() => setOpen(false))} className="h-8 self-start rounded-md border border-line-2 bg-surface px-3 text-[12.5px] text-ink-2">
                Lock again
              </button>
            </>
          ) : (
            <>
              <span className="text-[12.5px] leading-normal text-ink-2">
                Browsing is free. Sending evidence to the real PayPal sandbox and live AI runs need the demo code.
              </span>
              {demo.unlockable ? <DemoUnlockForm autoFocus onDone={() => setOpen(false)} /> : <span className="text-[12.5px] text-warn">No demo code is configured on this server.</span>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
