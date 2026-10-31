import { STATUS_NOT_VERIFIED, type ActionAvailability } from './actions';

/** What an action's «What to do» card says: the composer's own verdict (actionAvailability), in a few words. */
export interface ActionCardVerdict {
  /** ResolveKit can compose and send it now (the composer will not say «Not available»). */
  sendable: boolean;
  /** The reason, short enough for a card; null when sendable. */
  short: string | null;
  /** The composer's full reason; null when sendable. */
  why: string | null;
}

const OWNER_ONLY_PREFIX = 'Only the workspace owner';

/** A card's words for a reason: the frequent ones shortened, any other as the composer gives it. */
function shortReason(why: string): string {
  if (why === STATUS_NOT_VERIFIED) return 'not verified from this status';
  if (why.startsWith(OWNER_ONLY_PREFIX)) return 'owner only';
  return why.charAt(0).toLowerCase() + why.slice(1);
}

/**
 * The card's verdict from the same availability the composer receives. Absent (evidence, which keeps its own checks):
 * allowed, as before.
 */
export function actionCardVerdict(a: ActionAvailability | null | undefined): ActionCardVerdict {
  if (!a || a.sendable) return { sendable: true, short: null, why: null };
  const why = a.why ?? 'not available';
  return { sendable: false, short: shortReason(why), why };
}
