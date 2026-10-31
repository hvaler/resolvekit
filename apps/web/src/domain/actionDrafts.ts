import type { ActionCode } from './types';

/**
 * What the merchant typed in an action's composer (other than a message, whose text and file the case page keeps):
 * the note to PayPal, the amount as typed, and the chosen type (an accept's REFUND / PARTIAL_REFUND). Kept by the case
 * page while the action dialog is closed, so closing it never loses a draft; cleared once PayPal recorded the send.
 */
export interface ActionDraft {
  note: string;
  value: string;
  picked: string | null;
}
export const EMPTY_ACTION_DRAFT: ActionDraft = Object.freeze({ note: '', value: '', picked: null }) as ActionDraft;

export type OtherAction = Exclude<ActionCode, 'provide_evidence'>;
export type ActionDrafts = Partial<Record<OtherAction, ActionDraft>>;

/** Whether closing the action's dialog leaves typed text behind (kept, and said so). */
export function hasUnsentDraft(action: OtherAction, drafts: ActionDrafts, message: string): boolean {
  if (action === 'send_message') return message.trim().length > 0;
  const d = drafts[action];
  return !!d && (d.note.trim().length > 0 || d.value.trim().length > 0);
}

/** The drafts without the one of an action PayPal recorded. */
export function withoutDraft(drafts: ActionDrafts, action: OtherAction): ActionDrafts {
  const { [action]: _sent, ...rest } = drafts;
  return rest;
}

/** Esc closes the action dialog (before a send; the flow's own dialog handles its steps). */
export const dialogKeyCloses = (key: string): boolean => key === 'Escape';

/**
 * When the review/send flow closes: after a recorded send the composer closes too (the case returns to the default
 * action; PayPal may no longer offer the one just sent); otherwise the composer is shown again with the draft intact.
 */
export function afterFlowClosed(recorded: boolean): { closeComposer: boolean } {
  return { closeComposer: recorded };
}

/**
 * Whether the action dialog is on screen: only while opened from a card in this page (in memory, never restored), and
 * while an action other than evidence is selected.
 */
export const composerShown = (open: boolean, otherAction: OtherAction | null): boolean => open && otherAction !== null;
