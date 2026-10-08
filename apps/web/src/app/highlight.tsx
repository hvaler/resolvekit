import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Cross-linking between claims, evidence and timeline. Hovering or focusing a citation chip lights the
 * exact cited fragments; hovering a document or a timeline event lights the claims that rely on it.
 */
export interface Highlight {
  /** Evidence id. */
  ev: string;
  /** Fragment keys to light inside the document. Empty: the document as a whole. */
  frags: string[];
  /** Sentence that cites it, when the highlight comes from a chip. */
  sid?: string;
}

interface HighlightValue {
  hl: Highlight | null;
  setHl: (h: Highlight | null) => void;
}

const Ctx = createContext<HighlightValue>({ hl: null, setHl: () => undefined });

export function HighlightProvider({ children }: { children: ReactNode }) {
  const [hl, setHl] = useState<Highlight | null>(null);
  const value = useMemo(() => ({ hl, setHl }), [hl]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHighlight(): HighlightValue {
  return useContext(Ctx);
}

/** Handlers for mouse and keyboard (focus) that set a highlight and clear it on leave/blur. */
export function useHoverHighlight() {
  const { setHl } = useHighlight();
  return (h: Highlight | null) =>
    h
      ? {
          onMouseEnter: () => setHl(h),
          onMouseLeave: () => setHl(null),
          onFocus: () => setHl(h),
          onBlur: () => setHl(null),
        }
      : {};
}

/** Is this fragment of this document lit? */
export function isFragmentLit(hl: Highlight | null, ev: string, fragment: string | undefined): boolean {
  return !!hl && hl.ev === ev && !!fragment && hl.frags.includes(fragment);
}
