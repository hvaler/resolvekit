import { analysisKey, buildInput, withAnalysis, type CaseAnalysis } from '@resolvekit/analyst';
import { describe, expect, it } from 'vitest';
import { analysisLabel } from '../components/AnalysisBar';
import { caseFiles, standardCase } from '../fixtures';
import { goldenAnalyses } from '../fixtures/golden';
import { AnalysisClient, AnalysisRequestError, AnalysisUnreachableError } from './analysisClient';
import { deriveSentences, notesText } from './draft';

describe('golden analyses', () => {
  it('exist for every case file and were made from exactly the documents the app shows (else: npm run golden -- --golden)', async () => {
    for (const c of Object.values(caseFiles)) {
      const g = goldenAnalyses[c.summary.id]!;
      expect(g, c.summary.id).toBeDefined();
      expect(await analysisKey(buildInput(c), g.requestedModel, g.promptVersion)).toBe(g.key);
    }
  });

  it('render through the web types: supported sentences only in the notes, the merchant’s unsupported note removed', () => {
    const g = goldenAnalyses[standardCase.summary.id]!;
    const c = withAnalysis(standardCase, g, buildInput(standardCase));
    const views = deriveSentences(c.sentences, { edits: {}, checking: null, analysisStep: 99, rejectionStep: c.analysis.rejectionStep });
    const phone = views.find((v) => v.text === 'The customer confirmed receipt by phone.')!;
    expect(phone.state).toBe('rejected');
    expect(phone.fromNote).toBe(true);
    expect(notesText(views)).not.toContain('by phone');
    expect(c.evidence.find((e) => e.id === 'E6')!.warning).toMatch(/contains instructions/);
    // Every citation shown carries the exact quote, and the quote is in the document.
    for (const s of c.sentences) for (const ct of s.citations) for (const q of ct.quotes ?? []) expect(JSON.stringify(c.evidence)).toContain(q.replace(/"/g, '\\"'));
  });

  it('every case: the merchant’s unsupported note is removed, never sent, and every quote is in its document', () => {
    for (const base of Object.values(caseFiles)) {
      const g = goldenAnalyses[base.summary.id]!;
      const c = withAnalysis(base, g, buildInput(base));
      const views = deriveSentences(c.sentences, { edits: {}, checking: null, analysisStep: 99, rejectionStep: c.analysis.rejectionStep });
      const removed = views.filter((v) => v.state === 'rejected');
      expect(removed.length, base.summary.id).toBeGreaterThan(0);
      for (const v of removed) expect(notesText(views)).not.toContain(v.text);
      expect(views.filter((v) => v.state === 'supported').length, base.summary.id).toBeGreaterThan(0);
      // Quotes are verbatim text of the document as the analyst read it (lines joined, whitespace normalised).
      const text = (id: string) => (buildInput(base).documents.find((d) => d.id === id)?.lines ?? []).map((l) => l.text).join(' ').replace(/\s+/g, ' ');
      for (const s of c.sentences) for (const ct of s.citations) for (const q of ct.quotes ?? []) expect(text(ct.evidenceId), base.summary.id).toContain(q.replace(/\s+/g, ' '));
    }
  });
});

describe('analysis label', () => {
  const a = { model: 'gemini-3.8-flash', requestedModel: 'gemini-3.8-flash', createdAt: '2026-10-09T06:07:24.730Z', promptVersion: 'p', usage: { calls: [], inputTokens: 1, outputTokens: 2, thinkingTokens: 0 } } as unknown as CaseAnalysis;
  const input = buildInput(standardCase);
  it('says who made it, when, and cached or live', () => {
    expect(analysisLabel({ kind: 'ready', analysis: a, origin: 'golden', input }).text).toBe('Analysis by gemini-3.8-flash · 9 Oct 2026 · cached');
    expect(analysisLabel({ kind: 'ready', analysis: a, origin: 'bundled', input }).title).toMatch(/no server connected/);
    expect(analysisLabel({ kind: 'ready', analysis: a, origin: 'live', input })).toMatchObject({ text: 'Analysis by gemini-3.8-flash · 9 Oct 2026 · live', live: true });
    const fb = { ...a, model: 'openai/gpt-oss-120b' } as CaseAnalysis;
    expect(analysisLabel({ kind: 'ready', analysis: fb, origin: 'live', input }).text).toBe('Analysis by openai/gpt-oss-120b · 9 Oct 2026 (fallback for gemini-3.8-flash) · live');
    expect(analysisLabel({ kind: 'unavailable', reason: 'why' })).toMatchObject({ text: 'No analysis', title: 'why' });
  });
});

describe('analysis client', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('posts only the case id (the server builds the documents) and returns ready / running answers', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ status: 'running', key: 'k', progress: [] }), { status: 202 });
    }) as unknown as typeof fetch;
    const r = await new AnalysisClient({ fetch: f }).analyse('PP-R-TVH-10190665', true);
    expect(r.status).toBe('running');
    expect(sent!.url).toBe('/api/cases/PP-R-TVH-10190665/analysis?refresh=1');
    expect(JSON.parse(String(sent!.init.body))).toEqual({});
  });

  it('a refused run carries the reason and the live budget; no server is told apart', async () => {
    const err = await new AnalysisClient({ fetch: reply(429, { error: 'RATE_LIMITED', detail: 'limit', live: { configured: true, model: 'm', remaining: 0, limit: 6, resetInSec: 60 } }) })
      .analyse('X')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisRequestError);
    expect((err as AnalysisRequestError).live?.remaining).toBe(0);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new AnalysisClient({ fetch: down }).analyse('X')).rejects.toBeInstanceOf(AnalysisUnreachableError);
    const proxyOnly = (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(new AnalysisClient({ fetch: proxyOnly }).analyse('X')).rejects.toBeInstanceOf(AnalysisUnreachableError);
  });
});
