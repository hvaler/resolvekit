/**
 * Actions other than evidence are composed in a modal (as the evidence flow is): a visible Close (×), Cancel and Esc
 * before sending; an unsent draft is kept, and the dialog says so; after a recorded send, closing returns to the case
 * with the default action selected and the sent draft cleared (no stale «Not available» form).
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaseDraft } from '../app/useCaseDraft';
import { EMPTY_ACTION_DRAFT, afterFlowClosed, dialogKeyCloses, hasUnsentDraft, withoutDraft, type ActionDrafts } from '../domain/actionDrafts';
import { actionAvailability } from '../domain/actions';
import type { CaseFile, DisputeSnapshot } from '../domain/types';
import { ActionComposer, ActionComposerDialog, FIRST_FIELD, initialFocus } from './ActionComposer';
import { ActionChoice } from './ResponseComposer';

const noop = () => {};
const owner = { role: 'owner' as const, reviewer: false };
const waiting: DisputeSnapshot = {
  id: 'CASE-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  allowedActions: ['provide_evidence', 'send_message', 'accept_claim', 'make_offer', 'escalate'],
  responseOptions: { acceptClaimTypes: ['REFUND', 'PARTIAL_REFUND'], offerTypes: ['REFUND'] },
  amount: { value: '7.00', currency: 'USD' },
  allowedRefund: { value: '7.00', currency: 'USD' },
  evidences: [],
  readAt: '',
};

describe('the action dialog', () => {
  it('is a modal with a Close (×) and a Cancel before anything is sent', () => {
    const html = renderToString(
      <ActionComposerDialog caseId="CASE-1" title="Escalate" draftKept={false} onClose={noop}>
        <p>composer</p>
      </ActionComposerDialog>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('<p>composer</p>');
    expect(html).not.toContain('draft is kept');
  });

  it('with text typed: says closing keeps the draft (nothing is sent)', () => {
    const html = renderToString(
      <ActionComposerDialog caseId="CASE-1" title="Escalate" draftKept onClose={noop}>
        <p>composer</p>
      </ActionComposerDialog>,
    );
    expect(html).toContain('Closing keeps your unsent draft; nothing is sent.');
  });

  it('Esc closes; other keys do not', () => {
    expect(dialogKeyCloses('Escape')).toBe(true);
    expect(dialogKeyCloses('Enter')).toBe(false);
  });
});

describe('drafts survive closing the dialog', () => {
  it('the composers show the kept draft (escalate note, offer amount and note, accept type, amount and note)', () => {
    const esc = renderToString(
      <ActionComposer action="escalate" text="" onText={noop} availability={actionAvailability(waiting, 'escalate', owner)} locked={null} onReview={noop} onRequest={noop} draft={{ ...EMPTY_ACTION_DRAFT, note: 'Kept escalation note' }} onDraft={noop} />,
    );
    expect(esc).toContain('Kept escalation note');
    const off = renderToString(
      <ActionComposer action="make_offer" text="" onText={noop} availability={actionAvailability(waiting, 'make_offer', owner)} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} draft={{ note: 'Kept offer note', value: '2.00', picked: null }} onDraft={noop} />,
    );
    expect(off).toContain('Kept offer note');
    expect(off).toContain('value="2.00"');
    const acc = renderToString(
      <ActionComposer action="accept_claim" text="" onText={noop} availability={actionAvailability(waiting, 'accept_claim', owner)} locked={null} onReview={noop} onRequest={noop} disputeAmount={waiting.amount!} draft={{ note: 'Kept accept note', value: '3.00', picked: 'PARTIAL_REFUND' }} onDraft={noop} />,
    );
    expect(acc).toContain('Kept accept note');
    expect(acc).toContain('value="3.00"');
    expect(acc).toContain(`<input type="radio" name="accept-type" checked="" value="PARTIAL_REFUND"/>`);
    expect(acc).toContain(`<input type="radio" name="accept-type" value="REFUND"/>`);
  });

  it('an unsent draft is text typed in the action’s composer (blank does not count)', () => {
    const drafts: ActionDrafts = { escalate: { ...EMPTY_ACTION_DRAFT, note: 'x' }, make_offer: { ...EMPTY_ACTION_DRAFT, note: '  ' } };
    expect(hasUnsentDraft('escalate', drafts, '')).toBe(true);
    expect(hasUnsentDraft('make_offer', drafts, '')).toBe(false);
    expect(hasUnsentDraft('make_offer', { make_offer: { ...EMPTY_ACTION_DRAFT, value: '2.00' } }, '')).toBe(true);
    expect(hasUnsentDraft('accept_claim', drafts, '')).toBe(false);
    expect(hasUnsentDraft('send_message', drafts, 'Hello')).toBe(true);
    expect(hasUnsentDraft('send_message', drafts, '   ')).toBe(false);
    expect(withoutDraft(drafts, 'escalate')).toEqual({ make_offer: drafts.make_offer });
  });

  it('the card of an action with an unsent draft says it is kept', () => {
    const c = { recommendation: null, actionDetails: {} } as unknown as CaseFile;
    const d = { action: 'provide_evidence', setAction: noop } as unknown as CaseDraft;
    const html = renderToString(<ActionChoice c={c} d={d} allowed={waiting.allowedActions} checkedAt={null} sent={false} drafted={['escalate']} />);
    const cards = html.match(/<button[^>]*role="radio"[\s\S]*?<\/button>/g) ?? [];
    expect(cards.find((b) => b.includes('· escalate'))).toContain('Unsent draft kept');
    expect(cards.filter((b) => b.includes('Unsent draft kept'))).toHaveLength(1);
  });
});

describe('closing after the flow', () => {
  it('recorded: back to the default action, the sent draft cleared; otherwise back to the composer, draft intact', () => {
    expect(afterFlowClosed(true)).toEqual({ closeComposer: true });
    expect(afterFlowClosed(false)).toEqual({ closeComposer: false });
  });
});

describe('initial focus', () => {
  it('the dialog can take focus (tabindex -1)', () => {
    const html = renderToString(
      <ActionComposerDialog caseId="CASE-1" title="Escalate" draftKept={false} onClose={noop}>
        <p>composer</p>
      </ActionComposerDialog>,
    );
    expect(html).toMatch(/role="dialog"[^>]*tabindex="-1"/);
  });

  it('focuses the first enabled field, else the dialog itself', () => {
    const focused: string[] = [];
    const el = (name: string) => ({ focus: () => void focused.push(name) });
    initialFocus({ querySelector: () => el('note'), focus: () => void focused.push('dialog') });
    initialFocus({ querySelector: () => null, focus: () => void focused.push('dialog') });
    expect(focused).toEqual(['note', 'dialog']);
    expect(FIRST_FIELD).toContain('textarea:not([disabled])');
  });
});
