/**
 * A citation chip brings the cited document into view: when its highlight starts (hover or focus) and the evidence
 * card is outside its scrolling column, the card is scrolled into view (nearest, smooth; instant when the person
 * prefers reduced motion). A visible card, a column that does not scroll (narrow layout: the page itself scrolls) or a
 * highlight already on do nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { revealOnStart } from './highlight';
import { revealEvidence, type RevealEnv } from '../components/EvidenceCard';

type Box = { top: number; bottom: number };
function fakeDom(o: { card?: Box; column?: Box; scrolls?: boolean; reduced?: boolean } = {}) {
  const scrollIntoView = vi.fn();
  const column = { parentElement: null, scrollHeight: o.scrolls === false ? 300 : 2000, clientHeight: 300, getBoundingClientRect: () => o.column ?? { top: 100, bottom: 400 } };
  const wrapper = { parentElement: column, scrollHeight: 50, clientHeight: 50, getBoundingClientRect: () => ({ top: 0, bottom: 0 }) };
  const card = { parentElement: wrapper, scrollIntoView, getBoundingClientRect: () => o.card ?? { top: 900, bottom: 1000 } };
  const ids: string[] = [];
  const env: RevealEnv = {
    byId: (id) => {
      ids.push(id);
      return id === 'evidence-E5' ? (card as never) : null;
    },
    overflowY: (el) => (el === (column as never) ? 'auto' : 'visible'),
    reducedMotion: () => !!o.reduced,
  };
  return { env, scrollIntoView, ids };
}

describe('revealEvidence', () => {
  it('a card below its scrolled column: scrolled into view, nearest and smooth', () => {
    const f = fakeDom();
    expect(revealEvidence('E5', f.env)).toBe(true);
    expect(f.ids).toEqual(['evidence-E5']);
    expect(f.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });
  it('above the column too; with reduced motion, instant', () => {
    const f = fakeDom({ card: { top: 20, bottom: 90 }, reduced: true });
    expect(revealEvidence('E5', f.env)).toBe(true);
    expect(f.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });
  it('a visible card, a column that does not scroll, or no such card: nothing scrolls', () => {
    const visible = fakeDom({ card: { top: 150, bottom: 300 } });
    expect(revealEvidence('E5', visible.env)).toBe(false);
    expect(visible.scrollIntoView).not.toHaveBeenCalled();
    const flat = fakeDom({ scrolls: false });
    expect(revealEvidence('E5', flat.env)).toBe(false);
    expect(flat.scrollIntoView).not.toHaveBeenCalled();
    expect(revealEvidence('E9', fakeDom().env)).toBe(false);
  });
  it('without a browser (server render): nothing happens', () => {
    expect(revealEvidence('E5')).toBe(false);
  });
});

describe('revealOnStart', () => {
  it('the highlight starting (hover or focus) reveals once; while it is on, nothing more; leaving is unchanged', () => {
    const setHl = vi.fn();
    const reveal = vi.fn();
    const base = { onMouseEnter: () => setHl('on'), onMouseLeave: () => setHl(null), onFocus: () => setHl('on'), onBlur: () => setHl(null) };
    const off = revealOnStart(base, false, reveal);
    off.onMouseEnter();
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(setHl).toHaveBeenCalledWith('on');
    // Re-rendered with the highlight on: focusing or entering the same chip does not scroll again.
    const on = revealOnStart(base, true, reveal);
    on.onFocus();
    on.onMouseEnter();
    expect(reveal).toHaveBeenCalledTimes(1);
    on.onMouseLeave();
    expect(setHl).toHaveBeenLastCalledWith(null);
    revealOnStart(base, false, reveal).onFocus();
    expect(reveal).toHaveBeenCalledTimes(2);
  });
});
