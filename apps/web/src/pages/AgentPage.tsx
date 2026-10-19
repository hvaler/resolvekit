import { useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAgentRun } from '../app/useAgentRun';
import { useServices } from '../app/services';
import { AccountMenu } from '../components/AccountMenu';
import { Logo, MERCHANT, ThemeControls } from '../components/AppBar';
import { Code, PrimaryAction, Spinner, cx } from '../components/ui';
import { canStart, compareRows, isLive, outcomeText, runActions, runTotals, settlementText, stepBadges, stepLine, usageText, workspaceToggle, type AgentRun, type AgentStep, type StepBadge } from '../domain/agentRun';
import { environmentOf, signInUrl } from '../domain/environment';
import { utcStamp } from '../domain/time';

/** Editable examples: one the tools can meet, one that needs the costly export, one they cannot meet. */
const EXAMPLES = [
  'Get the current quote for ACME-42 and a short report on its supplier risk, spending as little as possible.',
  'Export 100 rows of the quotes-2026-10 dataset and tell me their checksum.',
  'Find the price history of ACME-42 over the last year.',
];
const DEFAULT_CAP = '2.00';
/** The paid tool whose first call fails on purpose when the person asks for a simulated outage. */
const OUTAGE_TOOL = 'deep_report';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';
const TONE: Record<Tone, string> = {
  ok: 'border-ok-line bg-ok-soft text-ok',
  warn: 'border-warn-line bg-warn-soft text-warn',
  bad: 'border-bad-line bg-bad-soft text-bad',
  info: 'border-info-line bg-info-soft text-info',
  muted: 'border-line-2 bg-surface-2 text-ink-2',
};

function toneOf(run: AgentRun): Tone {
  if (isLive(run.state)) return 'info';
  if (run.state === 'done') return 'ok';
  if (run.state === 'cannot_do' || run.state === 'out_of_budget') return 'warn';
  return 'bad';
}

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cx('whitespace-nowrap rounded-sm border px-[7px] py-px text-[11.5px] font-semibold', TONE[tone])}>{children}</span>;
}

const BADGE_TONE: Record<StepBadge, Tone> = { 'in progress': 'info', injected: 'info', 'not charged': 'muted', uncertain: 'warn' };

function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx('flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4', className)}>
      {title && <h2 className="m-0 text-heading-sm">{title}</h2>}
      {children}
    </section>
  );
}

function Notice({ tone, children }: { tone: 'bad' | 'info'; children: ReactNode }) {
  return (
    <p role={tone === 'bad' ? 'alert' : 'status'} className={cx('m-0 rounded-lg border px-3 py-2 text-body leading-normal', tone === 'bad' ? 'border-bad-line bg-bad-soft' : 'border-line-2 bg-surface-2')}>
      {children}
    </p>
  );
}

function StepItem({ step }: { step: AgentStep }) {
  const badges = stepBadges(step);
  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-line py-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 break-words font-mono text-[12.5px] text-ink">{stepLine(step)}</span>
        {step.state === 'pending' && <Spinner size={12} />}
        {badges.map((b) => (
          <Pill key={b} tone={BADGE_TONE[b]}>
            {b}
          </Pill>
        ))}
      </div>
      {step.reason && <span className="break-words text-[12.5px] text-ink-2">Reason: {step.reason}</span>}
    </li>
  );
}

function Steps({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return <span className="text-body text-ink-3">No steps yet.</span>;
  return (
    <ol aria-label="Steps" className="m-0 flex list-none flex-col p-0">
      {steps.map((s) => (
        <StepItem key={s.n} step={s} />
      ))}
    </ol>
  );
}

/**
 * The PayPal side: the cap, what MeterMCP's metering said per call (never presented as the settlement), and the
 * settlement as MeterMCP's receipt gave it, with the amounts only the receipt stated (Ruling A11).
 */
function Budget({ run }: { run: AgentRun }) {
  const t = runTotals(run);
  const rows: [string, ReactNode][] = [
    ['Budget cap', `${run.cap} USD`],
    ['Charged per call (MeterMCP metering)', `${t.charged} USD · ${t.okCalls} OK ${t.okCalls === 1 ? 'call' : 'calls'}`],
    ['Failed calls (not charged)', String(t.notCharged)],
    ...(t.uncertain ? ([['Calls with unknown result', String(t.uncertain)]] as [string, ReactNode][]) : []),
    ['Settlement (MeterMCP receipt)', settlementText(run)],
    ...(run.captureId ? ([['PayPal capture', <Code key="c">{run.captureId}</Code>]] as [string, ReactNode][]) : []),
    ...(run.orderId ? ([['PayPal order', <Code key="o">{run.orderId}</Code>]] as [string, ReactNode][]) : []),
    ...(run.sessionId ? ([['MeterMCP session', <Code key="s">{run.sessionId}</Code>]] as [string, ReactNode][]) : []),
    ...(run.receiptSha256 ? ([['Receipt SHA-256', <Code key="h">{run.receiptSha256.slice(0, 16)}…</Code>]] as [string, ReactNode][]) : []),
  ];
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="m-0 min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunDetail({ run, who, busy, onStop, onKeep }: { run: AgentRun; who: { owner: boolean; local: boolean }; busy: string | null; onStop: () => void; onKeep: (kept: boolean) => void }) {
  const live = isLive(run.state);
  const can = runActions(run, who);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={toneOf(run)}>{outcomeText(run)}</Pill>
          {run.viewedAs === 'owner' && <Pill tone="muted">Viewed as workspace owner</Pill>}
          {run.kept && <Pill tone="muted">Kept</Pill>}
          {live && <Spinner size={14} />}
          <span className="flex-1" />
          {can.stop && (
            <button type="button" disabled={busy === 'stop'} onClick={onStop} className="h-8 rounded-lg border border-line-2 bg-surface px-3 text-[12.5px] font-medium">
              Stop
            </button>
          )}
          {can.keep && (
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2" title="A kept run is never deleted by the 30-day retention.">
              <input type="checkbox" checked={run.kept} disabled={busy === 'keep'} onChange={(e) => onKeep(e.target.checked)} />
              Keep
            </label>
          )}
        </div>
        <p className="m-0 break-words text-body-lg">{run.goal}</p>
        <span className="text-[12px] text-ink-3">
          {run.by.label} · {utcStamp(new Date(run.createdAt))}
          {run.failFirst.length > 0 && ` · simulated outage: ${run.failFirst.join(', ')}`}
        </span>
        {can.approvalUrl && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-info-line bg-info-soft px-3 py-2.5">
            <span className="text-body text-ink-2">The agent wants to spend up to {run.cap} USD. Approve the budget in PayPal (sandbox); nothing is charged until calls succeed.</span>
            <a href={can.approvalUrl} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center rounded-lg bg-acc px-3.5 text-[13px] font-semibold text-acc-ink no-underline">
              Approve in PayPal
            </a>
          </div>
        )}
      </Card>

      <Card title="Steps">
        <Steps steps={run.steps} />
      </Card>

      {run.answer && (
        <Card title="Answer">
          <p className="m-0 whitespace-pre-wrap break-words text-body leading-normal">{run.answer}</p>
        </Card>
      )}

      <Card title="Budget and receipt">
        <Budget run={run} />
      </Card>

      <p className="m-0 text-[12.5px] text-ink-3">{usageText(run)}</p>
    </div>
  );
}

function Compare({ a, b, onClose }: { a: AgentRun; b: AgentRun; onClose: () => void }) {
  const rows = compareRows(a, b);
  const cell = (s: AgentStep | null) => (s ? <ol className="m-0 list-none p-0"><StepItem step={s} /></ol> : <span className="text-[12px] text-ink-3">—</span>);
  return (
    <Card>
      <div className="flex items-center gap-2">
        <h2 className="m-0 flex-1 text-heading-sm">Two runs side by side</h2>
        <button type="button" onClick={onClose} className="h-8 rounded-lg border border-line-2 bg-surface px-3 text-[12.5px]">
          Close
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 overflow-x-auto max-md:gap-x-2">
        {[a, b].map((r) => (
          <div key={r.id} className="flex min-w-0 flex-col gap-1 border-b border-line pb-2">
            <Pill tone={toneOf(r)}>{outcomeText(r)}</Pill>
            <span className="break-words text-body">{r.goal}</span>
            <span className="text-[12px] text-ink-2">{settlementText(r)}</span>
            <span className="text-[11.5px] text-ink-3">{usageText(r)}</span>
          </div>
        ))}
        {rows.map((row) => (
          <div key={row.n} className="contents">
            <div className="min-w-0">{cell(row.left)}</div>
            <div className="min-w-0">{cell(row.right)}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AgentPage() {
  const { demo, accountKnown, area } = useServices();
  const [params] = useSearchParams();
  const location = useLocation();
  const env = environmentOf(area, demo);
  const who = { owner: demo?.person?.role === 'owner', local: env.kind === 'local' };
  const agent = useAgentRun({ initialRun: params.get('run'), who: demo?.person?.id ?? '', enabled: accountKnown && env.kind !== 'signed-out' });
  const [goal, setGoal] = useState('');
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [outage, setOutage] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);

  if (!accountKnown) return <div className="min-h-[100dvh] bg-bg" />;
  if (env.kind === 'signed-out') return <Navigate to={signInUrl(location.pathname + location.search)} replace />;

  const mineLive = agent.runs.some((r) => r.viewedAs !== 'owner' && isLive(r.state));
  const startable = canStart({ goal, cap, starting: agent.busy === 'start', runs: agent.runs });
  const togglePick = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.slice(-1), id]));
  const pair = comparing && picked.length === 2 ? picked.map((id) => agent.runs.find((r) => r.id === id)).filter((r): r is AgentRun => !!r) : [];
  const input = 'rounded-lg border border-line-2 bg-surface px-2.5 text-body text-ink';

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg text-ink">
      <header className="flex h-11 flex-none items-center gap-3.5 border-b border-line bg-surface px-[18px] max-md:gap-2.5 max-md:px-4">
        <Logo />
        <span aria-hidden="true" className="h-[18px] w-px bg-line-2" />
        <Link to="/cases" className="text-[12.5px] text-ink-2 no-underline hover:text-ink">
          Cases
        </Link>
        <span aria-hidden="true" className="text-ink-3">
          /
        </span>
        <span aria-current="page" className="text-[12.5px] font-medium">
          Buying agent
        </span>
        <span className="flex-1" />
        <span className="max-md:hidden">
          <ThemeControls />
        </span>
        <AccountMenu fallback={MERCHANT} />
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-7 pb-8 pt-[22px] max-md:px-4">
        <div className="flex max-w-[760px] flex-col gap-1">
          <h1 className="m-0 text-title-lg">Buying agent</h1>
          <p className="m-0 text-body leading-normal text-ink-2">
            An AI model chooses MeterMCP’s paid tools to meet your goal, one action at a time, within a budget you approve in PayPal (sandbox). Code checks
            every action before it is made, only successful calls are charged, and the settlement is what MeterMCP’s receipt says. Each step shows the
            model’s stated reason; the tool outputs are synthetic.
          </p>
        </div>

        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-4 max-lg:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4">
            <Card title="New run">
              <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
                <label className="flex flex-col gap-1 text-[12.5px] text-ink-2">
                  Goal
                  <textarea value={goal} maxLength={300} rows={3} onChange={(e) => setGoal(e.target.value)} className={cx(input, 'py-2')} placeholder="What should the agent find out?" />
                </label>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-ink-3">Examples (they fill the field; edit them as you like)</span>
                  {EXAMPLES.map((x) => (
                    <button key={x} type="button" onClick={() => setGoal(x)} className="rounded-lg border border-dashed border-line-2 bg-surface-2 px-2.5 py-1.5 text-left text-[12.5px] text-ink-2">
                      {x}
                    </button>
                  ))}
                </div>
                <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  Budget cap (USD, 0.50 to 5.00)
                  <input value={cap} inputMode="decimal" onChange={(e) => setCap(e.target.value)} className={cx(input, 'h-9 w-24 font-mono')} />
                </label>
                <label className="flex items-start gap-2 text-[12.5px] text-ink-2">
                  <input type="checkbox" checked={outage} onChange={(e) => setOutage(e.target.checked)} className="mt-0.5" />
                  Simulate an outage: the first call to Deep report fails (marked as injected)
                </label>
                {mineLive && <span className="text-[12px] text-ink-3">One run at a time: wait for yours to end, or stop it.</span>}
                <PrimaryAction enabled={startable} onClick={() => void agent.start({ goal: goal.trim(), cap: cap.trim(), failFirst: outage ? [OUTAGE_TOOL] : [] })} className="w-full">
                  {agent.busy === 'start' ? 'Starting…' : 'Start the run'}
                </PrimaryAction>
                {agent.actionError && <Notice tone="bad">{agent.actionError}</Notice>}
              </form>
            </Card>

            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="m-0 flex-1 text-heading-sm">{agent.scope === 'workspace' ? 'Workspace runs' : 'Your runs'}</h2>
                {workspaceToggle(who) && (
                  <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
                    <input
                      type="checkbox"
                      checked={agent.scope === 'workspace'}
                      onChange={(e) => {
                        // Picks belong to the list they were made in.
                        setPicked([]);
                        setComparing(false);
                        agent.setScope(e.target.checked ? 'workspace' : 'mine');
                      }}
                    />
                    Workspace runs
                  </label>
                )}
                <button
                  type="button"
                  disabled={picked.length !== 2}
                  onClick={() => setComparing(true)}
                  className="h-8 rounded-lg border border-line-2 bg-surface px-3 text-[12.5px] font-medium disabled:text-ink-3"
                >
                  Compare{picked.length ? ` (${picked.length}/2)` : ''}
                </button>
              </div>
              {agent.listError && <Notice tone="bad">{agent.listError}</Notice>}
              {!agent.listKnown ? (
                <Spinner />
              ) : agent.runs.length === 0 ? (
                <span className="text-body text-ink-3">No runs yet.</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {agent.runs.map((r) => (
                    <li key={r.id} className={cx('flex items-start gap-2 rounded-lg border px-2.5 py-2', r.id === agent.selectedId ? 'border-acc bg-acc-soft' : 'border-line')}>
                      <input type="checkbox" aria-label="Pick to compare" checked={picked.includes(r.id)} onChange={() => togglePick(r.id)} className="mt-1" />
                      <button type="button" onClick={() => agent.select(r.id)} className="flex min-w-0 flex-1 flex-col gap-1 border-0 bg-transparent p-0 text-left">
                        <span className="line-clamp-2 break-words text-body">{r.goal}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                          <Pill tone={toneOf(r)}>{outcomeText(r)}</Pill>
                          {utcStamp(new Date(r.createdAt))}
                          {r.viewedAs === 'owner' && ` · ${r.by.label}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {pair.length === 2 && <Compare a={pair[0]!} b={pair[1]!} onClose={() => setComparing(false)} />}
            {agent.runError && <Notice tone="bad">{agent.runError}</Notice>}
            {agent.selected ? (
              <RunDetail run={agent.selected} who={who} busy={agent.busy} onStop={() => void agent.stop(agent.selected!)} onKeep={(k) => void agent.keep(agent.selected!, k)} />
            ) : (
              !agent.runError && (
                <Card>
                  <span className="text-body text-ink-3">{agent.selectedId ? 'Loading the run…' : 'Start a run, or pick one of your runs to see its steps.'}</span>
                </Card>
              )
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
