import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useServices } from '../app/services';
import { RoleChip, dateText } from '../components/AccountMenu';
import { Logo, ThemeControls } from '../components/AppBar';
import { Button, Spinner, cx } from '../components/ui';
import { AuthClient, SIGN_IN_ERRORS, passkeysSupported, type InviteRow, type InviteView, type MemberRow } from '../domain/authClient';

const auth = new AuthClient();

/** A same-site path to go back to after signing in (never another origin, never a protocol-relative URL). */
export function safeNext(raw: string | null): string {
  // Browsers read a backslash as a slash: any of them could turn the path into a protocol-relative URL.
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.startsWith('/api/')) return '/';
  return raw;
}

/** Full reload into the app: which disputes are live depends on who is signed in. */
const enterApp = (to = '/') => window.location.assign(safeNext(to));

function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg">
      <header className="flex h-11 flex-none items-center gap-3.5 border-b border-line bg-surface px-[18px] max-md:px-4">
        <Link to="/" className="no-underline">
          <Logo />
        </Link>
        <span className="flex-1" />
        <ThemeControls />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-10">
        <div className={cx('flex w-full flex-col gap-5 rounded-2xl border border-line bg-surface p-7 shadow-float max-md:p-5', wide ? 'max-w-[880px]' : 'max-w-[440px]')}>{children}</div>
      </main>
    </div>
  );
}

function Alert({ tone, children }: { tone: 'bad' | 'ok' | 'info'; children: ReactNode }) {
  const cls = { bad: 'border-bad-line bg-bad-soft', ok: 'border-ok-line bg-ok-soft', info: 'border-line-2 bg-surface-2' }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-xl border px-3.5 py-2.5 text-body leading-normal', cls)}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ sign in

export function SignInPage() {
  const { demo } = useServices();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const next = safeNext(params.get('next'));
  const errorCode = params.get('error');
  const [busy, setBusy] = useState<'paypal' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(errorCode ? (SIGN_IN_ERRORS[errorCode] ?? 'The sign-in did not complete. Try again.') : null);

  const paypal = async () => {
    setBusy('paypal');
    setError(null);
    const r = await auth.paypalStart();
    if (r.ok) window.location.assign(r.value.approvalUrl);
    else {
      setBusy(null);
      setError(r.error);
    }
  };
  const passkey = async () => {
    setBusy('passkey');
    setError(null);
    const r = await auth.signInWithPasskey();
    if (r.ok) enterApp(next);
    else {
      setBusy(null);
      setError(r.error);
    }
  };

  if (demo === null) {
    return (
      <AuthShell>
        <h1 className="m-0 text-[20px] font-semibold">No sign-in here</h1>
        <p className="m-0 text-body-lg leading-normal text-ink-2">This ResolveKit runs on your machine: you are the merchant, and nothing needs a sign-in.</p>
        <Link to="/" className="font-semibold text-acc">
          Open the cases
        </Link>
      </AuthShell>
    );
  }
  if (demo.signedIn && demo.person && demo.workspace) {
    return (
      <AuthShell>
        <h1 className="m-0 text-[20px] font-semibold">You are signed in</h1>
        <p className="m-0 flex flex-wrap items-center gap-2 text-body-lg">
          {demo.person.name} <RoleChip role={demo.person.role} reviewer={demo.person.reviewer} /> {demo.workspace.name}
        </p>
        <Button variant="primary" onClick={() => enterApp(next)}>
          Continue
        </Button>
      </AuthShell>
    );
  }
  return (
    <AuthShell>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[20px] font-semibold">Sign in to ResolveKit</h1>
        <p className="m-0 text-body leading-normal text-ink-2">Each merchant has its own workspace. The real PayPal disputes are answered only by the seller’s workspace.</p>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {demo.methods.paypal && (
        <div className="flex flex-col gap-1.5">
          <Button variant="primary" onClick={() => void paypal()} disabled={busy != null} data-testid="signin-paypal">
            {busy === 'paypal' ? 'Opening PayPal…' : 'Continue with PayPal'}
          </Button>
          <span className="text-[12.5px] leading-normal text-ink-2">
            For merchants. You approve a no-charge request in PayPal so we can confirm which account is yours. No money moves and no agreement is created.
          </span>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <Button onClick={() => void passkey()} disabled={busy != null || !passkeysSupported()}>
          {busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </Button>
        <span className="text-[12.5px] leading-normal text-ink-2">
          {passkeysSupported() ? 'For members who joined a workspace with a passkey.' : 'This browser cannot use passkeys.'}
        </span>
      </div>
      <p className="m-0 text-[12.5px] leading-normal text-ink-2">Have an invite link? Open it: it brings you to the workspace that invited you.</p>
      <div className="flex items-center gap-3 text-[12px] text-ink-3">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <Link to="/" className="self-center text-body font-medium text-acc">
        Explore without signing in
      </Link>
      <span className="self-center text-[11.5px] text-ink-3">PayPal sandbox · synthetic case data</span>
    </AuthShell>
  );
}

// ------------------------------------------------------------------------------------------------ join

export function JoinPage() {
  const token = useMemo(() => window.location.hash.replace(/^#/, ''), []);
  const [invite, setInvite] = useState<{ kind: 'loading' } | { kind: 'ok'; view: InviteView } | { kind: 'error'; message: string; code?: string }>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'passkey' | 'browser' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const canPasskey = passkeysSupported();

  useEffect(() => {
    // The token stays in the fragment (never sent to a server in a URL); clear it from the address bar.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setInvite({ kind: 'error', message: 'This page needs the full invite link.' });
      return;
    }
    void auth.inspectInvite(token).then((r) => setInvite(r.ok ? { kind: 'ok', view: r.value } : { kind: 'error', message: r.error, ...(r.code ? { code: r.code } : {}) }));
  }, [token]);

  const join = async (e: FormEvent | null, via: 'passkey' | 'browser') => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(via);
    setError(null);
    const r = via === 'passkey' ? await auth.joinWithPasskey(token, name.trim()) : await auth.joinThisBrowser(token, name.trim());
    if (r.ok) enterApp('/');
    else {
      setBusy(null);
      setError(r.error);
    }
  };

  if (invite.kind === 'loading') {
    return (
      <AuthShell>
        <p role="status" className="m-0 flex items-center gap-2.5 text-body text-ink-2">
          <Spinner /> Checking the invite…
        </p>
      </AuthShell>
    );
  }
  if (invite.kind === 'error') {
    const title = { INVITE_USED: 'This invite was already used', INVITE_EXPIRED: 'This invite has expired', INVITE_REVOKED: 'This invite was revoked' }[invite.code ?? ''] ?? 'This invite cannot be used';
    return (
      <AuthShell>
        <h1 className="m-0 text-[20px] font-semibold">{title}</h1>
        <p className="m-0 text-body-lg leading-normal text-ink-2">{invite.message} Ask the workspace owner for a new link.</p>
        <Link to="/" className="font-medium text-acc">
          Explore without signing in
        </Link>
      </AuthShell>
    );
  }
  const v = invite.view;
  return (
    <AuthShell>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold uppercase tracking-[.05em] text-ink-3">{v.reviewer ? 'Reviewer access' : 'Invitation'}</span>
        <h1 className="m-0 text-[20px] font-semibold">{v.workspace.name} invited you as a {v.reviewer ? 'reviewer' : 'member'}</h1>
      </div>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-body leading-normal text-ink-2">
        <li>You can review cases, approve responses and send them within the workspace’s daily limits.</li>
        <li>You cannot connect PayPal or manage members; the owner can revoke your access at any time.</li>
        {v.accessUntil && <li>Access until {dateText(v.accessUntil)}.</li>}
      </ul>
      {error && <Alert tone="bad">{error}</Alert>}
      <form onSubmit={(e) => void join(e, canPasskey ? 'passkey' : 'browser')} className="flex flex-col gap-3">
        <label htmlFor={nameId} className="flex flex-col gap-1 text-[12.5px] text-ink-2">
          Your name, as the audit trail will show it
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoComplete="name"
            required
            className="h-10 rounded-lg border border-line-2 bg-surface px-3 text-body-lg text-ink"
          />
        </label>
        {canPasskey && (
          <Button type="submit" variant="primary" disabled={!name.trim() || busy != null}>
            {busy === 'passkey' ? 'Waiting for your device…' : 'Create a passkey and join'}
          </Button>
        )}
        <Button type={canPasskey ? 'button' : 'submit'} onClick={canPasskey ? () => void join(null, 'browser') : undefined} disabled={!name.trim() || busy != null}>
          {busy === 'browser' ? 'Joining…' : 'Join for this browser only'}
        </Button>
        <span className="text-[12px] leading-normal text-ink-3">
          {canPasskey ? 'A passkey lets you sign in again on this device. “This browser only” ends when the session does (12 hours).' : 'This browser cannot create passkeys: you join for this browser only (12 hours).'}
        </span>
      </form>
    </AuthShell>
  );
}

// ------------------------------------------------------------------------------------------------ members (Owner)

export function MembersPage() {
  const { demo } = useServices();
  const navigate = useNavigate();
  const [data, setData] = useState<{ members: MemberRow[]; invites: InviteRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ label: 'Hackathon judges', reviewer: true, maxUses: 50, ttlDays: 70, accessUntil: '2026-12-15' });
  const load = () => void auth.members().then((r) => (r.ok ? setData(r.value) : setError(r.error)));
  useEffect(load, []);

  if (demo && (!demo.signedIn || demo.person?.role !== 'owner')) {
    return (
      <AuthShell>
        <h1 className="m-0 text-[20px] font-semibold">Owners only</h1>
        <p className="m-0 text-body-lg leading-normal text-ink-2">Only the workspace owner, signed in with PayPal, manages members and invites.</p>
        <Button onClick={() => navigate('/')}>Back to the cases</Button>
      </AuthShell>
    );
  }
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await auth.createInvite({ label: form.label, reviewer: form.reviewer, maxUses: form.maxUses, ttlDays: form.ttlDays, accessUntil: form.reviewer && form.accessUntil ? `${form.accessUntil}T23:59:00Z` : null });
    if (r.ok) {
      setCreated(r.value.url);
      setCopied(false);
      load();
    } else setError(r.error);
  };
  const act = async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p;
    if (!r.ok) setError(r.error ?? 'The change was refused.');
    load();
  };
  const input = 'h-9 rounded-lg border border-line-2 bg-surface px-2.5 text-body text-ink';
  return (
    <AuthShell wide>
      <div className="flex items-center gap-3">
        <h1 className="m-0 flex-1 text-[20px] font-semibold">Members and invites · {demo?.workspace?.name}</h1>
        <Link to="/" className="text-body font-medium text-acc">
          Back to the cases
        </Link>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[15px] font-semibold">Members</h2>
        {!data ? (
          <Spinner />
        ) : (
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="text-left text-[12px] text-ink-3">
                <th className="py-1.5 font-medium">Name</th>
                <th className="py-1.5 font-medium">Role</th>
                <th className="py-1.5 font-medium">Joined with</th>
                <th className="py-1.5 font-medium">Last active (UTC)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id} className={cx('border-t border-line', m.revokedAt && 'text-ink-3')}>
                  <td className="py-2">{m.name}</td>
                  <td className="py-2">
                    <RoleChip role={m.role} reviewer={m.reviewer} />
                  </td>
                  <td className="py-2">{m.via === 'paypal' ? 'PayPal' : m.via === 'passkey' ? `passkey${m.passkeys > 1 ? ` ×${m.passkeys}` : ''}` : 'this browser only'}</td>
                  <td className="py-2 font-mono text-[12px]">{m.lastActiveAt.slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-2 text-right">
                    {m.revokedAt ? 'Revoked' : m.role !== 'owner' && <button type="button" onClick={() => void act(auth.revokeMember(m.id))} className="rounded-md border border-line-2 bg-surface px-2 py-1 text-[12px]">Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[15px] font-semibold">Invite links</h2>
        {data && data.invites.length > 0 && (
          <table className="w-full border-collapse text-body">
            <tbody>
              {data.invites.map((i) => {
                const dead = i.revokedAt || Date.parse(i.expiresAt) <= Date.now() || i.uses >= i.maxUses;
                return (
                  <tr key={i.id} className={cx('border-t border-line', dead && 'text-ink-3')}>
                    <td className="py-2">{i.label}</td>
                    <td className="py-2">{i.reviewer ? 'Reviewer' : 'Member'}</td>
                    <td className="py-2">
                      {i.uses} / {i.maxUses} used
                    </td>
                    <td className="py-2">expires {dateText(i.expiresAt)}</td>
                    <td className="py-2 text-right">{i.revokedAt ? 'Revoked' : !dead && <button type="button" onClick={() => void act(auth.revokeInvite(i.id))} className="rounded-md border border-line-2 bg-surface px-2 py-1 text-[12px]">Revoke</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <form onSubmit={(e) => void create(e)} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface-2 p-3.5">
          <label className="flex flex-col gap-1 text-[12px] text-ink-2">
            Label
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={60} required className={input} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-2">
            Uses
            <input type="number" min={1} max={300} value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })} className={cx(input, 'w-20')} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-2">
            Link valid (days)
            <input type="number" min={1} max={120} value={form.ttlDays} onChange={(e) => setForm({ ...form, ttlDays: Number(e.target.value) })} className={cx(input, 'w-24')} />
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
            <input type="checkbox" checked={form.reviewer} onChange={(e) => setForm({ ...form, reviewer: e.target.checked })} />
            Reviewer
          </label>
          {form.reviewer && (
            <label className="flex flex-col gap-1 text-[12px] text-ink-2">
              Access until
              <input type="date" value={form.accessUntil} onChange={(e) => setForm({ ...form, accessUntil: e.target.value })} className={input} />
            </label>
          )}
          <Button type="submit" variant="primary">
            Create invite link
          </Button>
        </form>
        {created && (
          <Alert tone="ok">
            <span className="flex flex-col gap-1.5">
              <strong>Copy this link now: it is shown only once.</strong>
              <code className="break-all font-mono text-[12px]">{created}</code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(created).then(() => setCopied(true))}
                className="self-start rounded-md border border-line-2 bg-surface px-2.5 py-1 text-[12px]"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </span>
          </Alert>
        )}
      </section>
    </AuthShell>
  );
}
