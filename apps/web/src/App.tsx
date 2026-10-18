import { Navigate, Route, Routes, useMatch, useParams } from 'react-router-dom';
import { useState } from 'react';
import { setRecording, useRecording } from './app/recording';
import { ServicesProvider, useServices } from './app/services';
import { environmentOf, knownBound, workspaceRoute } from './domain/environment';
import type { SimulatedOutcome } from './domain/gateway';
import { JoinPage, MembersPage, SignInPage } from './pages/AuthPages';
import { CasePage } from './pages/CasePage';
import { LandingPage } from './pages/LandingPage';
import { InboxPage } from './pages/InboxPage';
import { CheckingPage, RetryingPage, WaitingPage } from './pages/WaitingPage';
import { processingDispute } from './fixtures';

const OUTCOMES: { v: SimulatedOutcome; l: string }[] = [
  { v: 'waiting_for_buyer', l: 'Waiting for buyer' },
  { v: 'under_review', l: 'Under review by PayPal' },
  { v: 'timeout', l: 'Timeout → read back → safe retry' },
];

/** Dev-only, simulator only: choose what the simulated PayPal does (after evidence is submitted, new disputes, outages). */
function DevOutcomeControl() {
  const { outcome, setOutcome, simulator, refreshAll, modeOf } = useServices();
  const [offline, setOffline] = useState(false);
  const caseMatch = useMatch('/cases/:id/*');
  // The outcome picker drives the simulator only: a case on real PayPal gets what PayPal does.
  if (caseMatch?.params.id && modeOf(caseMatch.params.id).kind === 'paypal') return null;
  return (
    <details className="fixed bottom-3 left-3 z-[60] rounded-xl border border-dashed border-line-2 bg-surface px-2.5 py-1.5 text-[11.5px] text-ink-2 shadow-[0_2px_8px_rgba(0,0,0,.08)]">
      <summary className="cursor-pointer">Dev · simulator</summary>
      <div className="mt-1.5 flex items-center gap-2">
        <label htmlFor="dev-outcome">PayPal re-read outcome</label>
        <select
          id="dev-outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as SimulatedOutcome)}
          className="rounded-sm border border-line-2 bg-surface px-1 py-0.5 text-[11.5px]"
        >
          {OUTCOMES.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            simulator.openNow(processingDispute.id);
            void refreshAll([processingDispute.id]);
          }}
          className="rounded-sm border border-line-2 bg-surface px-1.5 py-0.5"
        >
          PayPal opens {processingDispute.id} now
        </button>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={offline}
            onChange={(e) => {
              setOffline(e.target.checked);
              simulator.setOffline(e.target.checked);
            }}
          />
          PayPal unreachable
        </label>
      </div>
      <label className="mt-1.5 flex items-center gap-1" title="For the demo video: slower analysis replay (1.2 s per step) and this panel hidden. Turn off with ?record=0.">
        <input type="checkbox" checked={false} onChange={(e) => setRecording(e.target.checked)} />
        Recording mode (hides this panel)
      </label>
    </details>
  );
}

function showDevControls(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return new URLSearchParams(window.location.search).has('dev');
  } catch {
    return false;
  }
}

/** `/`: a signed-out visitor on the hosted demo gets the landing page; everyone else goes to the cases. */
function Home() {
  const { demo, accountKnown } = useServices();
  if (!accountKnown) return <div className="min-h-[100dvh] bg-bg" />;
  return demo && !demo.signedIn ? <LandingPage /> : <Navigate to="/cases" replace />;
}

/** `/cases` and `/cases/:id/*`: what they show depends on the environment (see `workspaceRoute`). */
function WorkspaceCases() {
  const { id = null } = useParams();
  const { area, demo, accountKnown, modeKnown, health } = useServices();
  const env = environmentOf(area, demo);
  // Nothing is decided before the account and (for an evaluation workspace) the bound cases are known.
  if (!accountKnown || (env.kind === 'evaluation' && !modeKnown)) return <div className="min-h-[100dvh] bg-bg" />;
  const route = workspaceRoute(env, { caseId: id }, knownBound(health));
  switch (route.kind) {
    case 'redirect':
      return <Navigate to={route.to} replace />;
    case 'waiting':
      return <WaitingPage />;
    case 'checking':
      return <CheckingPage />;
    case 'retrying':
      return <RetryingPage />;
    case 'case':
      return <CasePage />;
    default:
      return <InboxPage />;
  }
}

/** `/demo/*`: the public Explore demo, on its own services (simulator only) inside the workspace's account state. */
function DemoArea() {
  return (
    <ServicesProvider area="demo">
      <Routes>
        <Route index element={<InboxPage />} />
        <Route path="cases" element={<InboxPage />} />
        <Route path="cases/:id/*" element={<CasePage />} />
        <Route path="*" element={<Navigate to="/demo" replace />} />
      </Routes>
    </ServicesProvider>
  );
}

export function App() {
  const recording = useRecording();
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/demo/*" element={<DemoArea />} />
        <Route path="/cases" element={<WorkspaceCases />} />
        <Route path="/cases/:id/*" element={<WorkspaceCases />} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/workspace" element={<MembersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Recording mode (demo video) hides the Dev control; everything else on screen is unchanged. */}
      {typeof window !== 'undefined' && !recording && showDevControls() && <DevOutcomeControl />}
    </>
  );
}
