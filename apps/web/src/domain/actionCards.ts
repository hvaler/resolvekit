import { STATUS_NOT_VERIFIED, type ActionAvailability } from './actions';

/** What an action's «What to do» card says: the composer's own verdict (actionAvailability), in a few words. */
export interface ActionCardVerdict {
  /** ResolveKit can compose and send it now (the composer will not say «Not available»). */
  sendable: boolean;
  /**
   * Not sendable by this viewer, but the composer shows a read-only preview with its consequence (an owner-only action
   * for a member or reviewer): the card stays selectable. False when the composer would show nothing useful.
   */
  preview: boolean;
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
  // An ordinary first word is lowercased; a name with another capital in it (PayPal, ResolveKit) is kept as written.
  const first = why.split(/[^A-Za-z]/, 1)[0] ?? '';
  return /^[A-Z][a-z]*$/.test(first) ? why.charAt(0).toLowerCase() + why.slice(1) : why;
}

/**
 * The card's verdict from the same availability the composer receives. Absent (evidence, which keeps its own checks):
 * allowed, as before.
 */
export function actionCardVerdict(a: ActionAvailability | null | undefined): ActionCardVerdict {
  if (!a || a.sendable) return { sendable: true, preview: false, short: null, why: null };
  const why = a.why ?? 'not available';
  if (why.startsWith(OWNER_ONLY_PREFIX)) {
    // The preview needs a variant the composer would show; otherwise the card says why there is none.
    if (a.variants.some((v) => v.variant && v.available)) return { sendable: false, preview: true, short: 'owner only', why };
    const inner = a.variants.find((v) => v.variant && v.why)?.why ?? a.variants[0]?.why ?? why;
    return { sendable: false, preview: false, short: shortReason(inner), why: inner };
  }
  return { sendable: false, preview: false, short: shortReason(why), why };
}
