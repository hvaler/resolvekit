/**
 * The citation chip itself asks for its document to be brought into view: hovering or focusing it calls
 * revealEvidence with the cited evidence id (mocked here; its own behaviour is tested in app/highlight.test.ts).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '../domain/types';

const reveal = vi.hoisted(() => vi.fn(() => false));
vi.mock('./EvidenceCard', async (actual) => ({ ...(await actual<typeof import('./EvidenceCard')>()), revealEvidence: reveal }));

const { CitationChip } = await import('./SentenceRow');

/** The chip's rendered button, with its handlers (rendered inside React, so its hooks run). */
function chipButton(): ReactElement<{ onMouseEnter: () => void; onFocus: () => void; onMouseLeave: () => void }> {
  let el: ReactElement | null = null;
  const citation = { evidenceId: 'E5', fragments: ['E5.msg'] } as unknown as Citation;
  function Capture() {
    el = CitationChip({ sentenceId: 'S1', citation, evidence: [] }) as ReactElement;
    return el;
  }
  renderToString(<Capture />);
  return el as unknown as ReactElement<{ onMouseEnter: () => void; onFocus: () => void; onMouseLeave: () => void }>;
}

describe('CitationChip brings its document into view', () => {
  beforeEach(() => reveal.mockClear());
  it('on hover: revealEvidence with the cited id, once', () => {
    chipButton().props.onMouseEnter();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith('E5');
  });
  it('on keyboard focus too; leaving does not', () => {
    const b = chipButton();
    b.props.onFocus();
    b.props.onMouseLeave();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith('E5');
  });
});
