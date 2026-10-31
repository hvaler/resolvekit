/**
 * The «What to do» cards say what the composer will say: an action PayPal offers that ResolveKit cannot send now (not
 * verified from this status, owner only) is shown muted and disabled with the reason, never «✓ allowed»; the footer
 * counts PayPal's links and, when fewer, how many ResolveKit can send now.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaseDraft } from '../app/useCaseDraft';
import { actionCardVerdict } from '../domain/actionCards';
import { actionAvailability, OWNER_ACTIONS, STATUS_NOT_VERIFIED, type Viewer } from '../domain/actions';
import type { ActionCode, CaseFile, DisputeSnapshot } from '../domain/types';
import { ActionChoice } from './ResponseComposer';

const c = { recommendation: null, actionDetails: {} } as unknown as CaseFile;
const d = { action: 'provide_evidence', setAction: () => {} } as unknown as CaseDraft;
const ALLOWED: ActionCode[] = ['provide_evidence', 'send_message', 'accept_claim', 'escalate'];
const waitingBuyer: DisputeSnapshot = {
  id: 'CASE-1',
  status: 'WAITING_FOR_BUYER_RESPONSE',
  stage: 'INQUIRY',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  allowedActions: ALLOWED,
  responseOptions: { acceptClaimTypes: ['REFUND'], offerTypes: [] },
  amount: { value: '7.00', currency: 'USD' },
  allowedRefund: { value: '7.00', currency: 'USD' },
  evidences: [],
  readAt: '',
};
const owner: Viewer = { role: 'owner', reviewer: false };
const verdictsFor = (snap: DisputeSnapshot, who = owner) =>
  Object.fromEntries(snap.allowedActions.filter((a) => a !== 'provide_evidence').map((a) => [a, actionCardVerdict(actionAvailability(snap, a, who))]));
const cards = (html: string) => html.match(/<button[^>]*role="radio"[\s\S]*?<\/button>/g) ?? [];
const card = (html: string, code: string) => cards(html).find((b) => b.includes(`· ${code}<`) || b.includes(`>${code}<`)) ?? '';

describe('actionCardVerdict', () => {
  it('sendable: allowed; not verified from this status or owner only: the short reason, with the full one', () => {
    expect(actionCardVerdict(undefined)).toEqual({ sendable: true, preview: false, short: null, why: null });
    expect(actionCardVerdict({ action: 'escalate', offered: true, sendable: true, why: null, variants: [] }).sendable).toBe(true);
    const status = actionCardVerdict({ action: 'escalate', offered: true, sendable: false, why: STATUS_NOT_VERIFIED, variants: [] });
    expect(status).toEqual({ sendable: false, preview: false, short: 'not verified from this status', why: STATUS_NOT_VERIFIED });
    const own = actionCardVerdict(actionAvailability({ ...waitingBuyer, status: 'WAITING_FOR_SELLER_RESPONSE' }, 'escalate', { role: 'member', reviewer: false }));
    expect(own.short).toBe('owner only');
    // The composer shows a member the read-only preview with its consequence: the card opens it.
    expect(own.preview).toBe(true);
    expect(OWNER_ACTIONS).toContain('escalate');
    // Owner only and not verified from this status: the composer would show nothing useful, so no preview.
    const both = actionCardVerdict(actionAvailability(waitingBuyer, 'escalate', { role: 'member', reviewer: true }));
    expect(both).toMatchObject({ sendable: false, preview: false, short: 'not verified from this status' });
    // A reason starting with a name keeps its capital («PayPal», not «payPal»); an ordinary word is lowercased.
    const named = (why: string) => actionCardVerdict({ action: 'make_offer', offered: true, sendable: false, why, variants: [] }).short;
    expect(named('PayPal reports no refundable amount for this dispute')).toBe('PayPal reports no refundable amount for this dispute');
    expect(named('ResolveKit cannot send this type')).toBe('ResolveKit cannot send this type');
    expect(named('An offer of yours is pending with the buyer')).toBe('an offer of yours is pending with the buyer');
  });
});

describe('the cards match the composer', () => {
  it('WAITING_FOR_BUYER_RESPONSE: escalate is offered by PayPal but not verified from this status (muted, disabled, no ✓)', () => {
    const html = renderToString(<ActionChoice c={c} d={d} allowed={ALLOWED} checkedAt={null} sent={false} verdicts={verdictsFor(waitingBuyer)} />);
    const esc = card(html, 'escalate');
    expect(esc).not.toContain('✓ allowed');
    expect(esc).toContain('PayPal offers it · not verified from this status');
    expect(esc).toMatch(/disabled=""/);
    expect(esc).toContain(`title="Not available: ${STATUS_NOT_VERIFIED}"`);
    // The message is verified from this status: unchanged.
    const msg = card(html, 'send_message');
    expect(msg).toContain('✓ allowed · send_message');
    expect(msg).not.toMatch(/disabled=""/);
    // Footer: PayPal's links, and how many ResolveKit can send now.
    expect(html).toContain('PayPal allows these 4 actions');
    expect(html).toContain('ResolveKit can send 2 of them now');
  });

  it('a member: owner-only actions say so', () => {
    const snap = { ...waitingBuyer, status: 'WAITING_FOR_SELLER_RESPONSE' as const };
    const html = renderToString(<ActionChoice c={c} d={d} allowed={ALLOWED} checkedAt={null} sent={false} verdicts={verdictsFor(snap, { role: 'member', reviewer: false })} />);
    for (const code of ['accept_claim', 'escalate']) {
      // Muted, labelled a preview, and still selectable (judges join as reviewers and read the consequence there).
      expect(card(html, code)).toContain(`PayPal offers it · owner only · preview · ${code}`);
      expect(card(html, code)).not.toMatch(/disabled=""/);
      expect(card(html, code)).not.toContain('✓ allowed');
    }
    expect(html).toContain('ResolveKit can send 2 of them now');
  });

  it('everything sendable: every card «✓ allowed» and the footer as before', () => {
    const snap = { ...waitingBuyer, status: 'WAITING_FOR_SELLER_RESPONSE' as const };
    const html = renderToString(<ActionChoice c={c} d={d} allowed={ALLOWED} checkedAt={null} sent={false} verdicts={verdictsFor(snap)} />);
    for (const code of ALLOWED) expect(card(html, code)).toContain(`✓ allowed · ${code}`);
    expect(html).toContain('PayPal allows these 4 actions');
    expect(html).not.toContain('ResolveKit can send');
  });
});
