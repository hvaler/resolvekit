import { Navigate, Route, Routes } from 'react-router-dom';
import { useServices } from './app/services';
import type { SimulatedOutcome } from './domain/gateway';
import { CasePage } from './pages/CasePage';
import { InboxPage } from './pages/InboxPage';

const OUTCOMES: { v: SimulatedOutcome; l: string }[] = [
  { v: 'waiting_for_buyer', l: 'Waiting for buyer' },
  { v: 'under_review', l: 'Under review by PayPal' },
  { v: 'timeout', l: 'Timeout → read back → safe retry' },
];

/** Dev-only: choose what the simulated PayPal does when evidence is submitted. */
function DevOutcomeControl() {
  const { outcome, setOutcome } = useServices();
  return (
    <details className="fixed bottom-3 left-3 z-[60] rounded-lg border border-dashed border-line2 bg-surface px-2.5 py-1.5 text-[11.5px] text-ink2 shadow-[0_2px_8px_rgba(0,0,0,.08)]">
      <summary className="cursor-pointer">Dev</summary>
      <div className="mt-1.5 flex items-center gap-2">
        <label htmlFor="dev-outcome">PayPal re-read outcome</label>
        <select
          id="dev-outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as SimulatedOutcome)}
          className="rounded border border-line2 bg-surface px-1 py-0.5 text-[11.5px]"
        >
          {OUTCOMES.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
      </div>
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
  return (
    <>
      <Routes>
        <Route path="/" element={<InboxPage />} />
        <Route path="/cases/:id/*" element={<CasePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {typeof window !== 'undefined' && showDevControls() && <DevOutcomeControl />}
    </>
  );
}
