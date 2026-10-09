import { describe, expect, it } from 'vitest';
import { NORMAL_STEP_MS, RECORDING_STEP_MS, isRecording, recordingFromQuery, replayStepMs } from './recording';

describe('recording mode', () => {
  it('is off by default and turned on/off from the query string', () => {
    expect(isRecording()).toBe(false);
    expect(recordingFromQuery('')).toBeNull();
    expect(recordingFromQuery('?record')).toBe(true);
    expect(recordingFromQuery('?record=1')).toBe(true);
    expect(recordingFromQuery('?dev&record')).toBe(true);
    expect(recordingFromQuery('?record=0')).toBe(false);
    expect(recordingFromQuery('?record=off')).toBe(false);
  });
  it('slows the analysis replay to ~1.2 s per step only', () => {
    expect(replayStepMs(false)).toBe(NORMAL_STEP_MS);
    expect(replayStepMs(true)).toBe(RECORDING_STEP_MS);
    expect(RECORDING_STEP_MS).toBe(1200);
  });
});
