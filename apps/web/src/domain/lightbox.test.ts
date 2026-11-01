/** The landing page's zoomable screenshots: the open/close state, the keys, and the body scroll lock. */
import { describe, expect, it } from 'vitest';
import { enlargeLabel, lightbox, lightboxKey, lockScroll } from './lightbox';

describe('lightbox state', () => {
  it('opens on a click (or Enter / Space, the thumbnail being a button) and closes on ×, Esc or the backdrop', () => {
    expect(lightbox(false, { type: 'open' })).toBe(true);
    expect(lightbox(true, { type: 'close' })).toBe(false);
    expect(lightbox(true, { type: 'key', key: 'Escape' })).toBe(false);
    expect(lightbox(true, { type: 'backdrop', onBackdrop: true })).toBe(false);
  });
  it('a click on the image itself, or another key, keeps it open', () => {
    expect(lightbox(true, { type: 'backdrop', onBackdrop: false })).toBe(true);
    for (const key of ['Enter', ' ', 'a', 'Tab']) expect(lightbox(true, { type: 'key', key })).toBe(true);
  });
  it('closed stays closed on Esc or a backdrop click', () => {
    expect(lightbox(false, { type: 'key', key: 'Escape' })).toBe(false);
    expect(lightbox(false, { type: 'backdrop', onBackdrop: true })).toBe(false);
  });
});

describe('lightbox keys', () => {
  it('Esc closes; Tab stays in the dialog (its one control); anything else is left alone', () => {
    expect(lightboxKey('Escape')).toBe('close');
    expect(lightboxKey('Tab')).toBe('trap');
    for (const key of ['Enter', ' ', 'ArrowLeft']) expect(lightboxKey(key)).toBeNull();
  });
});

describe('the thumbnail', () => {
  it('is named for what it does', () => {
    expect(enlargeLabel('A case file.')).toBe('Enlarge: A case file.');
  });
});

describe('body scroll lock', () => {
  it('hides the overflow while open and restores the previous value on close', () => {
    const body = { style: { overflow: 'auto' } };
    const restore = lockScroll(body);
    expect(body.style.overflow).toBe('hidden');
    restore();
    expect(body.style.overflow).toBe('auto');
  });
});
