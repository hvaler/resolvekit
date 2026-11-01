/** The landing page's zoomable screenshots: what opens and closes the enlarged view (the component is LandingPage's). */

export type LightboxEvent = { type: 'open' } | { type: 'close' } | { type: 'key'; key: string } | { type: 'backdrop'; onBackdrop: boolean };

/** Open or not, after an event: × and Esc close it, and so does a click on the backdrop (not on the image). */
export function lightbox(open: boolean, e: LightboxEvent): boolean {
  switch (e.type) {
    case 'open':
      return true;
    case 'close':
      return false;
    case 'key':
      return lightboxKey(e.key) === 'close' ? false : open;
    case 'backdrop':
      return e.onBackdrop ? false : open;
  }
}

/** A key inside the open dialog: Esc closes it; Tab stays on its one control (focus does not leave the modal). */
export function lightboxKey(key: string): 'close' | 'trap' | null {
  if (key === 'Escape') return 'close';
  if (key === 'Tab') return 'trap';
  return null;
}

/** The thumbnail's accessible name. */
export const enlargeLabel = (alt: string): string => `Enlarge: ${alt}`;

/** Locks the page's scroll while the dialog is open; returns what restores it. */
export function lockScroll(body: { style: { overflow: string } }): () => void {
  const before = body.style.overflow;
  body.style.overflow = 'hidden';
  return () => {
    body.style.overflow = before;
  };
}
