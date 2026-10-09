import type { ActionCode, DisputeStatus } from './types';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'acc' | 'muted';

export const STATUS_DISPLAY: Readonly<Record<DisputeStatus, { label: string; tone: Tone }>> = {
  UNDER_REVIEW: { label: 'Under review by PayPal', tone: 'info' },
  WAITING_FOR_SELLER_RESPONSE: { label: 'Waiting for your response', tone: 'warn' },
  WAITING_FOR_BUYER_RESPONSE: { label: 'Waiting for buyer', tone: 'info' },
  RESOLVED: { label: 'Resolved', tone: 'muted' },
  OPEN: { label: 'Open', tone: 'info' },
  OTHER: { label: 'Other (see PayPal)', tone: 'muted' },
};

export const STAGE_LABEL: Readonly<Record<string, string>> = {
  INQUIRY: 'Inquiry',
  CHARGEBACK: 'Claim',
  PRE_ARBITRATION: 'Pre-arbitration',
  ARBITRATION: 'Arbitration',
};

export const ACTION_LABEL: Readonly<Record<ActionCode, string>> = {
  provide_evidence: 'Provide evidence',
  send_message: 'Send message',
  make_offer: 'Make an offer',
  accept_claim: 'Accept claim',
  escalate: 'Escalate',
};


export function statusExplanation(status: DisputeStatus): string {
  switch (status) {
    case 'UNDER_REVIEW':
      return 'PayPal is reviewing the case. No action is needed from you right now.';
    case 'WAITING_FOR_BUYER_RESPONSE':
      return 'PayPal is waiting for the buyer to respond to your evidence.';
    case 'WAITING_FOR_SELLER_RESPONSE':
      return 'PayPal is waiting for your response.';
    case 'RESOLVED':
      return 'PayPal has closed this dispute.';
    case 'OPEN':
      return 'The dispute is open at PayPal.';
    case 'OTHER':
      return 'PayPal reports a status outside the usual flow. Check the dispute in PayPal.';
  }
}
