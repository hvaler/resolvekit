import { ACTION_LABEL } from './status';
import type { ActionCode, DisputeSnapshot } from './types';

export interface AllowedActionRow {
  code: ActionCode;
  label: string;
  allowed: boolean;
  why: string | null;
}

/**
 * Compare the actions PayPal allowed before sending with the ones it allows after the re-read,
 * explaining every action that disappeared.
 */
export function allowedActionsAfter(before: readonly ActionCode[], after: DisputeSnapshot): AllowedActionRow[] {
  const codes = [...before, ...after.allowedActions.filter((a) => !before.includes(a))];
  return codes.map((code) => {
    const allowed = after.allowedActions.includes(code);
    let why: string | null = null;
    if (!allowed) {
      if (code === 'provide_evidence' && after.evidences.length > 0) why = 'Removed by PayPal: evidence already submitted';
      else if (after.status === 'UNDER_REVIEW') why = 'Not offered while PayPal reviews';
      else why = 'No longer offered by PayPal';
    }
    return { code, label: ACTION_LABEL[code], allowed, why };
  });
}
