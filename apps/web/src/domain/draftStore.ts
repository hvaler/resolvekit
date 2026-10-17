/**
 * The response draft as one person left it (edits, the verifier's verdicts on them, contradiction resolutions, the
 * confirmations of what rests on corrected upload lines, the chosen action and evidence type), kept in this browser so a reload does not lose the work. A draft is not a
 * record: what is approved and sent is composed and kept by the server (intents, audit). Keyed by person, case and
 * analysis: another analysis (a re-run, or the case moved to another dispute) has other sentences, so its draft
 * starts over. Any storage failure means "no saved draft", never an error.
 */
import type { Recheck } from './draft';
import type { ActionCode, ContradictionResolution, EvidenceType } from './types';

export interface SavedDraft {
  edits: Record<string, string>;
  rechecks: Record<string, Recheck>;
  resolutions: Record<string, ContradictionResolution>;
  /** `sentenceId@fragment` pairs the merchant confirmed (domain/draft.ts `correctionPair`). Absent: none. */
  confirmedCorrections?: string[];
  action: ActionCode;
  evidenceType: EvidenceType | null;
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `scope`: the signed-in person's id, or "local"; `analysis`: the analysis key and its creation time. */
export function draftKey(o: { scope: string; caseId: string; analysis: string }): string {
  return `rk-draft:v1:${o.scope}:${o.caseId}:${o.analysis}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const NOT_RECHECKED: Recheck = {
  state: 'needs_review',
  reason: 'Why: this edit was not re-checked before the page was reloaded. Review it against the evidence yourself, or edit it again to re-check it.',
  note: 'Edited · not re-checked',
};

export function loadDraft(storage: DraftStorage | null | undefined, key: string): SavedDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as unknown;
    if (!isRecord(d) || d.v !== 1 || !isRecord(d.edits) || !isRecord(d.rechecks) || !isRecord(d.resolutions) || typeof d.action !== 'string') return null;
    const edits = Object.fromEntries(Object.entries(d.edits).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const rechecks = d.rechecks as Record<string, Recheck>;
    // A re-check still running when the page went away never came back: the edit is not verified.
    for (const id of Object.keys(edits)) if (!rechecks[id]) rechecks[id] = NOT_RECHECKED;
    return {
      edits,
      rechecks,
      resolutions: d.resolutions as Record<string, ContradictionResolution>,
      ...(Array.isArray(d.confirmedCorrections) ? { confirmedCorrections: d.confirmedCorrections.filter((p): p is string => typeof p === 'string') } : {}),
      action: d.action as ActionCode,
      evidenceType: typeof d.evidenceType === 'string' ? (d.evidenceType as EvidenceType) : null,
    };
  } catch {
    return null;
  }
}

export function saveDraft(storage: DraftStorage | null | undefined, key: string, d: SavedDraft): void {
  if (!storage) return;
  try {
    const empty = !Object.keys(d.edits).length && !Object.keys(d.resolutions).length && !d.confirmedCorrections?.length;
    if (empty) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ v: 1, ...d }));
  } catch {
    // Storage full or blocked: the draft lives in this page only.
  }
}

/** The browser's storage, or null where there is none or it is blocked. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
