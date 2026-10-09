/**
 * Recording mode, for the demo video (off by default): the analysis replay plays each step for ~1.2 s instead of
 * 0.65 s, and the Dev control is hidden. Nothing else changes: labels, provenance and every status stay exactly as
 * in normal use.
 *
 * Turn it on with `?record` in the URL (or the toggle in the Dev panel), off with `?record=0`. It is kept for the
 * browser tab (sessionStorage), so it survives navigating between cases.
 */
import { useSyncExternalStore } from 'react';

export const NORMAL_STEP_MS = 650;
export const RECORDING_STEP_MS = 1200;
const KEY = 'resolvekit.recording';

/** `?record` / `?record=1` → on, `?record=0|false|off` → off, absent → null (keep what the tab had). */
export function recordingFromQuery(search: string): boolean | null {
  const p = new URLSearchParams(search);
  if (!p.has('record')) return null;
  return !/^(0|false|off|no)$/i.test(p.get('record') ?? '');
}

function initial(): boolean {
  if (typeof window === 'undefined') return false;
  const q = recordingFromQuery(window.location.search);
  try {
    if (q !== null) window.sessionStorage.setItem(KEY, q ? '1' : '0');
    return q ?? window.sessionStorage.getItem(KEY) === '1';
  } catch {
    return q ?? false;
  }
}

let on = initial();
const listeners = new Set<() => void>();

export function isRecording(): boolean {
  return on;
}

export function setRecording(v: boolean): void {
  on = v;
  try {
    window.sessionStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* not kept across reloads; fine */
  }
  for (const l of listeners) l();
}

export function useRecording(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => on,
    () => false,
  );
}

/** How long each analysis step shows in a replay. */
export const replayStepMs = (recording: boolean) => (recording ? RECORDING_STEP_MS : NORMAL_STEP_MS);
