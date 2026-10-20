/**
 * A send holding the case's dispute (an action whose outcome PayPal has not proven yet), found again after a reload
 * (GET /api/disputes/:case/hold): the case page says so and offers «Check again» on THAT send — a read-back only, never
 * a send. Recorded or proven absent frees the dispute; anything else keeps it held ([A1], [A4]).
 */
import { useCallback, useEffect, useState } from 'react';
import { useServices } from '../app/services';
import { currentHold } from '../domain/actionSend';
import { IntentError, type DisputeHoldView, type IntentSource } from '../domain/intentClient';
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
export async function checkHeldSend(intents: Pick<IntentSource, 'readBack' | 'hold'>, hold: DisputeHoldView): Promise<HeldCheck> {
  try {
    const r = await intents.readBack({ caseId: hold.caseId, id: hold.intentId });
    if (!r) return { hold, message: PENDING, snapshot: null };
    const state = r.readBack.state;
    const after = r.hold !== undefined ? r.hold : state === 'pending' ? hold : null;
    if (state === 'recorded') return { hold: after, message: 'Recorded by PayPal: the earlier send is proven, and the dispute is free again.', snapshot: r.snapshot };
    if (state === 'absent') return { hold: after, message: 'PayPal shows no trace of the earlier send and still offers the action: the dispute is free again. Nothing was resent.', snapshot: r.snapshot };
    return { hold: after, message: r.readBack.detail || PENDING, snapshot: r.snapshot };
  } catch (e) {
    // A colleague's send that no longer holds the dispute is unknown to this person (404): ask what holds it now.
    if (e instanceof IntentError && e.status === 404 && e.code === 'UNKNOWN_INTENT') {
      const now = await currentHold(intents, hold.caseId);
      if (now !== undefined && now?.intentId !== hold.intentId) return { hold: now, message: 'The earlier send no longer holds this dispute (another read-back settled it): the dispute is free again.', snapshot: null };
    }
    return { hold, message: `${PENDING}: ${e instanceof Error ? e.message : String(e)}`, snapshot: null };
  }
}

/**
 * The hold of the case's dispute, read when the page opens (and when `refresh` changes), and its «Check again».
 * `known`: the server has said what holds the dispute (null included) since the last refresh.
 */
export function useHeldSend(caseId: string, live: boolean, refresh: unknown) {
  const { intents, applySnapshot } = useServices();
  const [hold, setHold] = useState<DisputeHoldView | null>(null);
  const [known, setKnown] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKnown(false);
    if (!live || intents.kind !== 'server') {
      setHold(null);
      return;
    }
    let on = true;
    intents
      .hold(caseId)
      .then((h) => {
        if (!on) return;
        setHold(h);
        setKnown(true);
      })
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
  return { hold, known, message, busy, check };
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

/**
 * The evidence flow's answer to 409 DISPUTE_UNCERTAIN, inline: the evidence was not sent because another send
 * (`holderId`) holds the dispute; the held-send notice with «Check again» on what holds it; «Send it now» only once the
 * server says nothing holds it (the evidence send then goes through every server check again).
 */
export function HeldEvidence({
  holderId,
  hold,
  known,
  message,
  busy,
  onCheck,
  onSendNow,
}: {
  holderId: string;
  hold: DisputeHoldView | null;
  /** The server said what holds the dispute (null included). */
  known: boolean;
  message: string | null;
  busy: boolean;
  onCheck: () => void;
  onSendNow: () => void;
}) {
  const free = known && !hold;
  return (
    <div data-testid="held-evidence" className="flex flex-col gap-3">
      <div role="alert" className="flex flex-col gap-1 rounded-2xl border border-warn-line bg-warn-soft px-[18px] py-4">
        <strong className="text-[15px] font-semibold">Your evidence was not sent</strong>
        <span className="text-body-lg leading-normal">
          {`An earlier send on this dispute (intent ${holderId.slice(0, 12)}…) is not confirmed by PayPal yet, so the ResolveKit server held your evidence back: none of it reached PayPal. «Check again» reads that send back; it never sends.`}
        </span>
      </div>
      {known ? (
        <HeldSendNotice hold={hold} message={message} busy={busy} onCheck={onCheck} />
      ) : (
        <p role="status" className="m-0 text-body text-ink-2">
          {message ?? 'Asking the ResolveKit server what holds this dispute…'}
        </p>
      )}
      {free && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={busy} onClick={onSendNow}>
            Send it now
          </Button>
          <span className="text-[12.5px] text-ink-2">The dispute is free again. Your evidence is read against PayPal and checked again by the server before it is sent.</span>
        </div>
      )}
    </div>
  );
}
