import { Link } from 'react-router-dom';
import { useServices } from '../app/services';
import { AccountMenu } from '../components/AccountMenu';
import { Logo, MERCHANT } from '../components/AppBar';
import { EnvironmentsHelp } from '../components/EnvironmentsHelp';
import { Spinner } from '../components/ui';
import { RoleChip } from '../components/AccountMenu';
import { SignOutActions } from '../components/SignOutActions';
import { CHECKING_TEXT, HEALTH_RETRY_TEXT, waitingCopy } from '../domain/copy';
import { environmentOf } from '../domain/environment';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg text-ink">
      <header className="flex h-11 flex-none items-center gap-3.5 border-b border-line bg-surface px-[18px]">
        <Logo />
        <span className="flex-1" />
        <AccountMenu fallback={MERCHANT} />
      </header>
      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-5 py-10 max-md:px-4">{children}</main>
    </div>
  );
}

/** A merchant's own workspace while the dispute connection is in validation and not yet available: what is and is not available. */
export function WaitingPage() {
  const { area, demo } = useServices();
  const env = environmentOf(area, demo);
  const copy = waitingCopy({ kind: 'merchant', owner: env.kind === 'merchant' ? env.owner : false });
  const owner = env.kind === 'merchant' && env.owner;
  return (
    <Frame>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-[20px] font-semibold leading-snug">{copy.status}</h1>
        <p className="m-0 text-body-lg leading-normal text-ink-2">{copy.explanation}</p>
      </div>
      <section className="flex flex-col gap-2 rounded-2xl border border-line bg-surface px-4 py-3.5">
        <Link to="/demo" className="self-start rounded-md bg-acc px-3.5 py-2 text-[13px] font-semibold text-acc-ink no-underline">
          {copy.demoButton}
        </Link>
        <span className="text-[12.5px] text-ink-2">{copy.demoNote}</span>
      </section>
      {owner && (
        <section className="flex flex-col gap-1">
          <Link to="/workspace" className="self-start text-[13px] font-medium text-acc">
            Members and invites
          </Link>
          <span className="text-[12.5px] text-ink-2">{copy.invitesNote}</span>
        </section>
      )}
      {demo?.person && demo.workspace && (
        <section aria-label="Account" className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-[13.5px] font-semibold">{demo.person.name}</strong>
            <RoleChip role={demo.person.role} reviewer={demo.person.reviewer} />
          </div>
          <span className="text-[12px] text-ink-2">{demo.workspace.name}</span>
          {demo.person.email && <span className="font-mono text-[11.5px] text-ink-3">{demo.person.email}</span>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <SignOutActions />
          </div>
        </section>
      )}
      <EnvironmentsHelp />
    </Frame>
  );
}

/** The account is signed in but its PayPal connection has not been read yet. */
export function CheckingPage() {
  return (
    <Frame>
      <div role="status" className="flex items-center gap-3 text-body-lg text-ink-2">
        <Spinner />
        {CHECKING_TEXT}
      </div>
    </Frame>
  );
}

/** The evaluation workspace while `/api/health` cannot be read: which cases are bound is unknown, so nothing is decided. */
export function RetryingPage() {
  const { retryHealth } = useServices();
  return (
    <Frame>
      <div role="status" className="flex items-center gap-3 text-body-lg text-ink-2">
        <Spinner />
        {HEALTH_RETRY_TEXT}
      </div>
      <button type="button" onClick={retryHealth} className="self-start rounded-md border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-ink">
        Retry now
      </button>
    </Frame>
  );
}
