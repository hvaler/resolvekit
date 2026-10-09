import { Navigate, Route, Routes, useMatch } from 'react-router-dom';
import { useState } from 'react';
import { setRecording, useRecording } from './app/recording';
import { useServices } from './app/services';
import type { SimulatedOutcome } from './domain/gateway';
import { CasePage } from './pages/CasePage';
import { InboxPage } from './pages/InboxPage';
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

export function App() {
  const recording = useRecording();
  return (
    <>
      <Routes>
        <Route path="/" element={<InboxPage />} />
        <Route path="/cases/:id/*" element={<CasePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* Recording mode (demo video) hides the Dev control; everything else on screen is unchanged. */}
      {typeof window !== 'undefined' && !recording && showDevControls() && <DevOutcomeControl />}
    </>
  );
}
