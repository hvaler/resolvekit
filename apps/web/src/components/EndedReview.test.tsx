/**
 * An ended discovered case is read-only: the draft's review affordances (rephrase, edit, confirm a correction) and the
 * contradiction's («Explain in response», «Mark resolved…») are not offered, and «What to do» shows no action, only
 * the read-only line. A case that is not read-only keeps them all.
 */
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaseDraft } from '../app/useCaseDraft';
import type { ActionCode, CaseFile, Contradiction, SentenceView } from '../domain/types';
import { ContradictionCard } from './ContradictionCard';
import { ActionChoice } from './ResponseComposer';
import { SentenceRow } from './SentenceRow';

const view = { id: 'S2', num: 2, text: 'The buyer confirmed receipt by phone.', state: 'needs_review', reason: 'No document shows the call.', citations: [] } as unknown as SentenceView;
const sentence = (readOnly: boolean) =>
  renderToString(
    <SentenceRow
      view={view}
      evidence={[]}
      editing={false}
      onEdit={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
      suggestion={{ label: 'Rephrase to what the evidence shows', text: 'Tracking shows delivery.' }}
      onApplySuggestion={() => {}}
      readOnly={readOnly}
    />,
  );

const contradiction = {
  id: 'C1',
  title: 'Delivery address differs',
  a: { evidenceId: 'E1', label: 'Order', value: 'Apt 4', fragment: 'E1.addr' },
  b: { evidenceId: 'E3', label: 'Carrier', value: 'Apt 4B', fragment: 'E3.addr' },
  assessment: 'Likely the same unit.',
  explainSentenceId: 'S3',
} as unknown as Contradiction;
const card = (readOnly: boolean) =>
  renderToString(<ContradictionCard contradiction={contradiction} resolution={{ status: 'open' }} visible onExplain={() => {}} onResolve={() => {}} readOnly={readOnly} />);

const c = { recommendation: { title: 'Provide evidence.', body: 'Tracking shows delivery.' }, actionDetails: {} } as unknown as CaseFile;
const d = { action: 'provide_evidence', setAction: () => {} } as unknown as CaseDraft;
const ALLOWED: ActionCode[] = ['provide_evidence', 'send_message', 'accept_claim'];

describe('an ended case offers no review of the draft', () => {
  it('a needs-review sentence: no rephrase, no edit; the state and reason stay', () => {
    const html = sentence(true);
    expect(html).not.toContain('Rephrase to what the evidence shows');
    expect(html).not.toContain('Edit sentence 2');
    expect(html).toContain('Needs review');
    expect(html).toContain('No document shows the call.');
    const open = sentence(false);
    expect(open).toContain('Rephrase to what the evidence shows');
    expect(open).toContain('Edit sentence 2');
  });
  it('an open contradiction: no «Explain in response», no «Mark resolved…»; a case not read-only keeps both', () => {
    const html = card(true);
    expect(html).not.toContain('Explain in response');
    expect(html).not.toContain('Mark resolved');
    expect(html).toContain('Delivery address differs');
    const open = card(false);
    expect(open).toContain('Explain in response');
    expect(open).toContain('Mark resolved');
  });
});

describe('«What to do» on an ended case', () => {
  it('no action cards and no recommendation, only the read-only line', () => {
    const html = renderToString(<ActionChoice c={c} d={d} allowed={ALLOWED} checkedAt={null} sent={false} ended />);
    expect(html).toContain('What to do');
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain('Provide evidence.');
    expect(html).toContain('data-testid="actions-ended"');
    expect(html).toContain('This case has ended · read-only');
    expect(html).not.toContain('PayPal allows');
  });
  it('a case not ended (a fixed case) keeps the cards, and «PayPal allows no actions…» when there are none', () => {
    const html = renderToString(<ActionChoice c={c} d={d} allowed={ALLOWED} checkedAt={null} sent={false} />);
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('actions-ended');
    expect(renderToString(<ActionChoice c={c} d={d} allowed={[]} checkedAt={null} sent={false} />)).toContain('PayPal allows no actions for this dispute right now.');
  });
});
