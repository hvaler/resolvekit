/**
 * A send holding the case's dispute (an action whose outcome PayPal has not proven yet), found again after a reload
 * (GET /api/disputes/:case/hold): the case page says so and offers «Check again» on THAT send — a read-back only, never
 * a send. Recorded or proven absent frees the dispute; anything else keeps it held ([A1], [A4]).
 */
import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../app/services';
import type { DisputeHoldView, IntentSource } from '../domain/intentClient';
import type { DisputeSnapshot } from '../domain/types';
import { Button } from './ui';

const PENDING = 'Outcome pending confirmation';

export interface HeldCheck {
  /** What holds the dispute after the check (null: free). */
  hold: DisputeHoldView | null;
  /** What the check found, in plain words. */
  message: string;
  /** The dispute as the read-back read it (applied to the page). */
  snapshot: DisputeSnapshot | null;
}

/** «Check again» on the holding send: read it back (never send) and say what PayPal proves. */
export async function checkHeldSend(intents: Pick<IntentSource, 'readBack'>, hold: DisputeHoldView): Promise<HeldCheck> {
  try {
    const r = await intents.readBack({ caseId: hold.caseId, id: hold.intentId });
    if (!r) return { hold, message: PENDING, snapshot: null };
    const state = r.readBack.state;
    const after = r.hold !== undefined ? r.hold : state === 'pending' ? hold : null;
    if (state === 'recorded') return { hold: after, message: 'Recorded by PayPal: the earlier send is proven, and the dispute is free again.', snapshot: r.snapshot };
    if (state === 'absent') return { hold: after, message: 'PayPal shows no trace of the earlier send and still offers the action: the dispute is free again. Nothing was resent.', snapshot: r.snapshot };
    return { hold: after, message: r.readBack.detail || PENDING, snapshot: r.snapshot };
  } catch (e) {
    return { hold, message: `${PENDING}: ${e instanceof Error ? e.message : String(e)}`, snapshot: null };
  }
}

/** The hold of the case's dispute, read when the page opens (and when `refresh` changes), and its «Check again». */
export function useHeldSend(caseId: string, live: boolean, refresh: unknown) {
  const { intents, applySnapshot } = useServices();
  const [hold, setHold] = useState<DisputeHoldView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!live || intents.kind !== 'server') {
      setHold(null);
      return;
    }
    let on = true;
    intents
      .hold(caseId)
      .then((h) => on && setHold(h))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [caseId, live, intents, refresh]);
  const check = useCallback(async () => {
    if (!hold) return;
    setBusy(true);
    try {
      const r = await checkHeldSend(intents, hold);
      if (r.snapshot) applySnapshot(r.snapshot);
      setHold(r.hold);
      setMessage(r.message);
    } finally {
      setBusy(false);
    }
  }, [hold, intents, applySnapshot]);
  return { hold, message, busy, check };
}

/** The notice: what holds the dispute, and «Check again» (a read-back only). After a check, what it found. */
export function HeldSendNotice({ hold, message, busy, onCheck }: { hold: DisputeHoldView | null; message: string | null; busy: boolean; onCheck: () => void }) {
  if (!hold) {
    return message ? (
      <p role="status" data-testid="held-send-settled" className="m-0 rounded-lg border border-ok-line bg-ok-soft px-3 py-2 text-[12.5px]">
        {message}
      </p>
    ) : null;
  }
  const whose = hold.own ? 'Your earlier send' : 'An earlier send by someone in your workspace';
  const what = hold.action ? ` (${hold.action.replace(/_/g, ' ')})` : '';
  return (
    <div role="status" data-testid="held-send" className="flex flex-col gap-1.5 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
      <strong className="font-semibold">{hold.state === 'in_flight' ? 'A send to this dispute is in progress' : PENDING}</strong>
      <span>
        {hold.state === 'in_flight'
          ? `${whose}${what} is being sent to PayPal right now; nothing else is sent until PayPal answers.`
          : `${whose}${what} is not confirmed by PayPal yet. Nothing else is sent to this dispute until a read-back proves it recorded or absent. «Check again» only reads PayPal; it never sends.`}
      </span>
      {!hold.intentKnown && (
        <span>This server no longer has that send’s approved content, so a read-back cannot settle it: the operator resolves it (see the operations runbook).</span>
      )}
      {message && <span>{message}</span>}
      <span className="font-mono text-caption text-ink-3">
        intent {hold.intentId.slice(0, 12)}… · since {hold.since}
      </span>
      {hold.state === 'uncertain' && (
        <span>
          <Button disabled={busy} onClick={onCheck}>
            Check again
          </Button>
        </span>
      )}
    </div>
  );
}
