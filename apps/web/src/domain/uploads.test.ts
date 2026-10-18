import { buildInput } from '@resolvekit/analyst';
import { standardCase } from '@resolvekit/cases';
import { describe, expect, it } from 'vitest';
import { correctionsOf, deriveSentences, linesToConfirmOf, transcriptionsOf, type DraftContext } from './draft';
import { composeSubmission, isComposeProblem, parseIntentRequest } from './intent';
import { fragmentTexts } from './quotes';
import type { CaseFile, SentenceView } from './types';
import {
  approvalRequest,
  canEditUpload,
  createUploadsClient,
  listRetryDelay,
  uploadsForInput,
  citedCorrections,
  provenanceOf,
  uploadsListReducer,
  type UploadsListState,
  attachmentChoices,
  confirmedUploads,
  correctionsToConfirm,
  dropPairsOf,
  evidenceCount,
  mergeRemoval,
  notAnalysed,
  pageLabel,
  pendingLine,
  canReviewUpload,
  toImageRect,
  transcribedLabel,
  uploadCorrections,
  uploadEvidence,
  withUploadDocuments,
  type UploadRecordView,
} from './uploads';

/** A confirmed upload as GET /api/cases/:id/uploads returns it (apps/server/src/uploads/routes.ts `view`). */
function confirmed(over: Partial<UploadRecordView> = {}): UploadRecordView {
  const id = over.evidenceId ?? 'E7';
  return {
    id: 'upl-0123456789abcdef01234567',
    caseId: standardCase.summary.id,
    boundDisputeId: null,
    evidenceId: id,
    kind: 'image',
    name: 'tracking.png',
    uploadedBy: { id: 'local', label: 'local operator', name: 'local operator' },
    status: 'confirmed',
    rects: [{ x: 10, y: 20, w: 100, h: 18 }],
    removals: [],
    readLines: ['UPS tracking', 'Not delivered 8 Oct 2026'],
    lines: [
      { text: 'UPS tracking', correctedBy: null, original: null },
      { text: 'Delivered 8 Oct 2026', correctedBy: 'local operator', original: 'Not delivered 8 Oct 2026' },
    ],
    sha256: 'a'.repeat(64),
    size: 2048,
    mime: 'image/png',
    createdAt: '2026-10-17T19:00:00.000Z',
    expiresAt: '2026-10-17T20:00:00.000Z',
    confirmedAt: '2026-10-17T19:05:00.000Z',
    document: {
      id,
      title: 'tracking.png',
      type: 'Merchant upload · image',
      source: 'Uploaded by local operator',
      tag: 'UPL',
      lines: [
        { text: 'UPS tracking', fragment: `${id}.l1` },
        { text: 'Delivered 8 Oct 2026', fragment: `${id}.l2`, corrected: 'local operator' },
      ],
    },
    ...over,
  };
}

const pending = (over: Partial<UploadRecordView> = {}): UploadRecordView => ({
  ...confirmed(),
  id: 'upl-fedcba9876543210fedcba98',
  evidenceId: null,
  name: 'chat.png',
  status: 'pending',
  lines: [],
  readLines: [],
  sha256: null,
  confirmedAt: null,
  document: null,
  ...over,
});

const views = (states: [string, SentenceView['state'], string[]][]): SentenceView[] =>
  states.map(([id, state, evs], i) => ({ id, num: i + 1, text: id, state, citations: evs.map((e) => ({ evidenceId: e, fragments: [] })), reason: null, note: null, edited: false }));

describe('merchant uploads in the case', () => {
  it('a confirmed upload becomes an evidence card with its provenance and lit-able fragments', () => {
    const e = uploadEvidence(confirmed());
    expect(e.id).toBe('E7');
    expect(e.title).toBe('tracking.png');
    expect(e.sourceLabel).toEqual({ kind: 'upload', text: 'Uploaded by local operator' });
    expect(e.meta).toMatchObject({ type: 'Merchant upload · image', tag: 'UPL', source: 'Uploaded by local operator', hash: 'a'.repeat(64) });
    // The server's fragments, so a citation of E7.l2 lights that line; the corrected line says who corrected it.
    expect(e.body).toEqual({
      kind: 'lines',
      lines: [
        { text: 'UPS tracking', fragment: 'E7.l1' },
        { text: 'Delivered 8 Oct 2026', fragment: 'E7.l2', corrected: 'local operator' },
      ],
    });
    expect(fragmentTexts(e)).toEqual({ 'E7.l1': 'UPS tracking', 'E7.l2': 'Delivered 8 Oct 2026' });
    // Pending uploads are not evidence yet; confirmed ones come in evidence order.
    const list = [confirmed({ evidenceId: 'E8', id: 'upl-111111111111111111111111' }), pending(), confirmed()];
    expect(confirmedUploads(list).map((u) => u.evidenceId)).toEqual(['E7', 'E8']);
  });

  it('the analysis input gets the uploads’ documents after the case’s own, exactly as the server builds it', () => {
    const base = buildInput(standardCase);
    const input = withUploadDocuments(base, [pending(), confirmed()]);
    expect(input.documents.map((d) => d.id)).toEqual([...base.documents.map((d) => d.id), 'E7']);
    expect(input.documents.at(-1)).toEqual(confirmed().document);
    expect(withUploadDocuments(base, [pending()])).toBe(base);
    // Until an analysis has read E7, the case says so.
    expect(notAnalysed([confirmed(), pending()], base)).toEqual(['E7']);
    expect(notAnalysed([confirmed()], input)).toEqual([]);
    expect(notAnalysed([confirmed()], null)).toEqual(['E7']);
  });

  it('the approval request carries the selected attachments and the confirmed corrections', () => {
    const corrections = uploadCorrections([confirmed()]);
    const v: SentenceView[] = [
      { id: 'S1', num: 1, text: 'Delivered.', state: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.l2'] }], reason: null, note: null, edited: false },
      { id: 'S2', num: 2, text: 'Paid.', state: 'supported', citations: [{ evidenceId: 'E1', fragments: [] }], reason: null, note: null, edited: false },
    ];
    const req = approvalRequest({
      evidenceType: 'PROOF_OF_FULFILLMENT',
      edits: {},
      resolutions: {},
      views: v,
      corrections,
      // A stale pair (a sentence that no longer cites the line) is not sent; duplicates collapse.
      confirmed: ['S1@E7.l2', 'S2@E7.l2', 'S1@E7.l2'],
      attachments: ['upl-ffffffffffffffffffffffff', 'upl-0123456789abcdef01234567', 'upl-ffffffffffffffffffffffff'],
    });
    expect(req.confirmedCorrections).toEqual(['S1@E7.l2']);
    expect(req.attachments).toEqual(['upl-0123456789abcdef01234567', 'upl-ffffffffffffffffffffffff']);
    // What the server parses is what the browser sent.
    expect(parseIntentRequest(req)).toEqual(req);
  });

  it('cited uploads are pre-selected; uncited ones are offered unticked', () => {
    const e7 = confirmed();
    const e8 = confirmed({ id: 'upl-222222222222222222222222', evidenceId: 'E8', name: 'chat.txt', kind: 'text', mime: 'application/pdf', lines: [{ text: 'Thanks', correctedBy: null, original: null }], document: { ...confirmed().document!, id: 'E8', lines: [{ text: 'Thanks', fragment: 'E8.l1' }] } });
    const e9 = confirmed({ id: 'upl-333333333333333333333333', evidenceId: 'E9' });
    // E9 is cited only by a removed sentence: that is no reason to attach it.
    const choices = attachmentChoices([e8, pending(), e7, e9], views([['S1', 'supported', ['E1', 'E7']], ['S2', 'rejected', ['E9']]]));
    expect(choices.map((c) => [c.evidenceId, c.cited, c.selected])).toEqual([
      ['E7', true, true],
      ['E8', false, false],
      ['E9', false, false],
    ]);
    expect(choices[0]).toMatchObject({ id: e7.id, name: 'tracking.png', provenance: 'Uploaded by local operator', corrected: 'lines corrected by local operator' });
    expect(choices[1]!.corrected).toBeNull();
  });

  it('a confirmation names one sentence and one corrected line; editing the sentence drops it', () => {
    const corrections = uploadCorrections([confirmed()]);
    const view: SentenceView = { id: 'S1', num: 1, text: 'x', state: 'needs_review', citations: [{ evidenceId: 'E7', fragments: ['E7.l1', 'E7.l2'] }], reason: 'any wording', note: null, edited: false, awaitsCorrections: ['E7.l2'] };
    // From the structured field, not the reason's words.
    expect(correctionsToConfirm(view, corrections, new Set()).map((k) => k.fragment)).toEqual(['E7.l2']);
    expect(correctionsToConfirm(view, corrections, new Set(['S1@E7.l2']))).toEqual([]);
    // Held back for another reason (the analyst's): nothing to confirm here, even if the words look alike.
    const { awaitsCorrections: _a, ...other } = view;
    expect(correctionsToConfirm({ ...other, reason: 'Why: it depends on your correction (looks the same)' }, corrections, new Set())).toEqual([]);
    expect(dropPairsOf(['S1@E7.l2', 'S10@E7.l2', 'S2@E7.l1'], 'S1')).toEqual(['S10@E7.l2', 'S2@E7.l1']);
  });

  it('the browser derives the same sentence states as the server’s composition for a case with a corrected upload', () => {
    const uploads = [confirmed(), pending()];
    const docs: CaseFile = { ...standardCase, evidence: [...standardCase.evidence, ...confirmedUploads(uploads).map(uploadEvidence)] };
    const c: CaseFile = {
      ...docs,
      sentences: [
        { id: 'S1', text: 'UPS recorded the delivery on 8 Oct 2026.', verdict: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.l2'], quotes: ['Delivered 8 Oct 2026'] }] },
        { id: 'S2', text: 'Order #10482 was paid.', verdict: 'supported', citations: [{ evidenceId: 'E1', fragments: [] }] },
      ],
      contradictions: [],
      analysis: { steps: ['a', 'b', 'c', 'd', 'e', 'f'], contradictionStep: 3, rejectionStep: 5, note: '' },
    };
    // The server: corrections from the input it built (case documents + the uploads' documents).
    const serverInput = withUploadDocuments(buildInput(standardCase), uploads);
    const server = (confirmedCorrections: string[]) =>
      composeSubmission({ c, req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {}, confirmedCorrections, attachments: [] }, verified: () => null, allowedActions: ['provide_evidence'], submitted: false, corrections: correctionsOf(serverInput.documents) });
    // The browser: corrections from the uploads list.
    const ctx: DraftContext = { edits: {}, checking: null, analysisStep: 6, rejectionStep: 5, contradictions: [], resolutions: {}, corrections: uploadCorrections(uploads) };
    const browser = (pairs: string[]) => deriveSentences(c.sentences, { ...ctx, confirmedCorrections: new Set(pairs) });

    const open = server([]);
    expect(isComposeProblem(open) && open.blockers).toEqual(['sentence 1 needs review']);
    expect(browser([]).map((v) => v.state)).toEqual(['needs_review', 'supported']);

    const ok = server(['S1@E7.l2']);
    if (isComposeProblem(ok)) throw new Error(ok.detail);
    expect(browser(['S1@E7.l2'])).toEqual(ok.views);
    expect(ok.views[0]!.note).toBe('Relies on line 2 of E7 as corrected by local operator');
  });

  it('a drawn rectangle becomes whole image pixels; selected text spans merge', () => {
    // Drawn from bottom-right to top-left on an image shown at half its size, partly outside it.
    expect(toImageRect({ x: 60, y: 40 }, { x: 10, y: -5 }, { width: 200, height: 100 }, { width: 400, height: 200 })).toEqual({ x: 20, y: 0, w: 100, h: 80 });
    // A click (no area) is not a rectangle.
    expect(toImageRect({ x: 5, y: 5 }, { x: 5.4, y: 5 }, { width: 200, height: 100 }, { width: 400, height: 200 })).toBeNull();
    expect(mergeRemoval([{ start: 0, end: 4 }, { start: 10, end: 12 }], { start: 3, end: 10 })).toEqual([{ start: 0, end: 12 }]);
    expect(mergeRemoval([{ start: 10, end: 12 }], { start: 2, end: 4 })).toEqual([{ start: 2, end: 4 }, { start: 10, end: 12 }]);
    expect(mergeRemoval([], { start: 4, end: 4 })).toEqual([]);
  });

  it('every document says what it is: an upload and who uploaded it, PayPal or MeterMCP data, or a synthetic demo document', () => {
    expect(provenanceOf(uploadEvidence(confirmed()))).toEqual({ kind: 'upload', text: 'Uploaded by local operator' });
    const demo = standardCase.evidence[0]!;
    expect(provenanceOf(demo)).toEqual({ kind: 'demo', text: 'Synthetic demo document' });
    // An existing demo label is kept (the agent case's "Demo data").
    expect(provenanceOf({ ...demo, sourceLabel: { kind: 'demo', text: 'Demo data' } })).toEqual({ kind: 'demo', text: 'Demo data' });
    expect(provenanceOf({ ...demo, sourceLabel: { kind: 'metermcp', text: 'From MeterMCP · session mm-1…' } })).toEqual({ kind: 'metermcp', text: 'From MeterMCP · session mm-1…' });
    // The capture read from PayPal is real; the simulated case's capture is demo data.
    const capture = { ...demo, paypalRecord: 'capture' as const };
    expect(provenanceOf({ ...capture, meta: { type: 'Disputed transaction', tag: 'PP', source: 'PayPal sandbox · dispute PP-D-1', received: 'read 2026-10-17T19:00:00Z', hash: '' } })).toEqual({ kind: 'paypal', text: 'From PayPal sandbox · dispute PP-D-1' });
    expect(provenanceOf(capture).kind).toBe('demo');
    expect(provenanceOf({ ...capture, meta: { type: 'Disputed transaction', tag: 'PP', source: 'PayPal', received: '—', hash: '' } })).toEqual({ kind: 'paypal', text: 'PayPal · not read yet' });
  });

  it('a citation says which of its lines were corrected, and by whom', () => {
    const e = uploadEvidence(confirmed());
    expect(citedCorrections(e, { evidenceId: 'E7', fragments: ['E7.l1', 'E7.l2'] })).toEqual([{ line: 2, fragment: 'E7.l2', by: 'local operator', kind: 'corrected', label: 'line 2 corrected by local operator' }]);
    expect(citedCorrections(e, { evidenceId: 'E7', fragments: ['E7.l1'] })).toEqual([]);
    expect(citedCorrections(standardCase.evidence[0]!, { evidenceId: 'E1', fragments: [] })).toEqual([]);
  });

  it('review and discard are for the people who can edit the upload, as the server decides', () => {
    const u = pending({ uploadedBy: { id: 'p_ana', label: 'Ana (member)', name: 'Ana' } });
    expect(canEditUpload(null, u)).toBe(true); // local mode: the operator
    expect(canEditUpload({ id: 'p_bo', role: 'owner', reviewer: true }, u)).toBe(true);
    expect(canEditUpload({ id: 'p_bo', role: 'member', reviewer: false }, u)).toBe(true);
    expect(canEditUpload({ id: 'p_bo', role: 'member', reviewer: true }, u)).toBe(false);
    expect(canEditUpload({ id: 'p_ana', role: 'member', reviewer: true }, u)).toBe(true);
  });

  it('the uploads list is known only once it came back; a failure says so and keeps what was known', () => {
    const start: UploadsListState = { uploads: [], known: false, refused: null, error: null };
    // The uploads route answered a real error: not known (the seller's analysis waits for it).
    const failed = uploadsListReducer(start, { type: 'failed', error: 'Upload storage failed', status: 500, code: 'STORAGE' });
    expect(failed).toEqual({ uploads: [], known: false, refused: null, error: 'Upload storage failed' });
    const loaded = uploadsListReducer(failed, { type: 'loaded', uploads: [confirmed()] });
    expect(loaded).toEqual({ uploads: [confirmed()], known: true, refused: null, error: null });
    // A later failure keeps the list it had (and says so); it is still known.
    expect(uploadsListReducer(loaded, { type: 'failed', error: 'x', status: 500, code: 'STORAGE' })).toEqual({ ...loaded, error: 'x' });
    // Not this person's to see: known, empty, with the server's reason.
    expect(uploadsListReducer(loaded, { type: 'refused', reason: 'Sign in' })).toEqual({ uploads: [], known: true, refused: 'Sign in', error: null });
    // One upload after an action.
    const p = pending();
    const put = uploadsListReducer(loaded, { type: 'put', id: p.id, upload: p });
    expect(put.uploads.map((x) => x.id)).toEqual([confirmed().id, p.id]);
    expect(uploadsListReducer(put, { type: 'put', id: p.id, upload: null }).uploads.map((x) => x.id)).toEqual([confirmed().id]);
  });

  it('a server that is not there (unreachable, a proxy or deploy 5xx without an error code) means no uploads: the analysis is not held', () => {
    const start: UploadsListState = { uploads: [], known: false, refused: null, error: null };
    const down = uploadsListReducer(start, { type: 'failed', error: 'The ResolveKit server could not be reached', status: 0, code: 'SERVER_UNREACHABLE' });
    expect(down).toEqual({ uploads: [], known: true, refused: null, error: 'The ResolveKit server could not be reached' });
    expect(uploadsListReducer(start, { type: 'failed', error: 'HTTP 502', status: 502, code: 'HTTP_502' }).known).toBe(true);
    // A 5xx with the route's own error code is the uploads route failing: held.
    expect(uploadsListReducer(start, { type: 'failed', error: 'x', status: 503, code: 'ANALYST_UNAVAILABLE' }).known).toBe(false);
    // Coming back replaces the empty list.
    expect(uploadsListReducer(down, { type: 'loaded', uploads: [confirmed()] })).toEqual({ uploads: [confirmed()], known: true, refused: null, error: null });
  });

  it('only someone who can have uploads waits for the list; anyone else is analysed without uploads', () => {
    const waiting: UploadsListState = { uploads: [], known: false, refused: null, error: 'x' };
    expect(uploadsForInput(waiting, true)).toBeNull();
    expect(uploadsForInput(waiting, false)).toEqual([]);
    const loaded: UploadsListState = { uploads: [confirmed()], known: true, refused: null, error: null };
    expect(uploadsForInput(loaded, true)).toEqual([confirmed()]);
    expect(uploadsForInput(loaded, false)).toEqual([]);
  });

  it('a failed list is retried by itself: 2, 5, 10, 20 s, then every 30 s for about two minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(listRetryDelay)).toEqual([2000, 5000, 10000, 20000, 30000, 30000, 30000, null]);
  });

  it('a list answer that is not a list (a static host answering /api with a page) is the server not being there', async () => {
    const html = (async () => new Response('<!doctype html><p>hi</p>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(createUploadsClient('PP-1', { fetch: html }).listUploads()).rejects.toMatchObject({ status: 0, code: 'SERVER_UNREACHABLE' });
    const proxy = (async () => new Response('Bad gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(createUploadsClient('PP-1', { fetch: proxy }).listUploads()).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
    const ok = (async () => Response.json({ uploads: [confirmed()] })) as unknown as typeof fetch;
    expect(await createUploadsClient('PP-1', { fetch: ok }).listUploads()).toEqual([confirmed()]);
  });

  it('pasted text the server cannot put in the PDF is refused with its message, which is what the panel shows', async () => {
    const detail = 'The text has “€” (U+20AC), which the PDF sent to PayPal cannot show: only Latin-1 characters (Western European letters and accents) can be pasted. Replace it (for example € with EUR, curly quotes with straight ones) and paste again.';
    const refused = (async () => Response.json({ error: 'TEXT_UNSUPPORTED', detail }, { status: 422 })) as unknown as typeof fetch;
    await expect(createUploadsClient('PP-1', { fetch: refused }).uploadText('Total 5 € paid', 'email.txt')).rejects.toMatchObject({ status: 422, code: 'TEXT_UNSUPPORTED', message: detail });
  });
});

/** A confirmed PDF upload of pages 2, 5 (no text) and 8, as the server shows it: its lines are in its document. */
const ANA = 'Ana Lopez (member)';
function confirmedPdf(signed = 'Signed by J. D.'): UploadRecordView {
  return confirmed({
    kind: 'pdf',
    name: 'invoice.pdf',
    uploadedBy: { id: 'p1', label: ANA, name: 'Ana Lopez' },
    mime: 'application/pdf',
    rects: [],
    readLines: [],
    lines: [],
    document: {
      id: 'E7',
      title: 'Uploaded PDF',
      type: 'Merchant upload · PDF',
      source: 'Uploaded by Ana Lopez',
      tag: 'UPL',
      lines: [
        { text: 'INVOICE 2026-114', fragment: 'E7.p2.l1' },
        { text: 'Total 89.00 USD', fragment: 'E7.p2.l2', corrected: ANA },
        { text: 'Delivered 8 Oct 2026', fragment: 'E7.p8.l1' },
        { text: signed, fragment: 'E7.p8.l2', transcribed: ANA },
      ],
    },
  });
}

describe('PDF uploads: page fragments and transcribed lines', () => {
  it('transcribed lines are found like corrected ones, with their page and their line in the page', () => {
    const docs = [confirmedPdf().document!];
    expect([...transcriptionsOf(docs).values()]).toEqual([{ kind: 'transcribed', line: 2, page: 8, fragment: 'E7.p8.l2', evidenceId: 'E7', text: 'Signed by J. D.', by: ANA }]);
    expect([...correctionsOf(docs).values()]).toEqual([{ kind: 'corrected', line: 2, page: 2, fragment: 'E7.p2.l2', evidenceId: 'E7', text: 'Total 89.00 USD', by: ANA }]);
    // One list of lines to confirm: corrected and transcribed, the same for the server and the browser.
    expect([...linesToConfirmOf(docs).keys()]).toEqual(['E7.p2.l2', 'E7.p8.l2']);
    expect([...uploadCorrections([confirmedPdf()]).keys()]).toEqual(['E7.p2.l2', 'E7.p8.l2']);
  });

  it('a sentence citing a transcribed line needs its sentence@line confirmation, on the server and in the browser alike', () => {
    const uploads = [confirmedPdf()];
    const c: CaseFile = {
      ...standardCase,
      evidence: [...standardCase.evidence, ...confirmedUploads(uploads).map(uploadEvidence)],
      sentences: [
        { id: 'S1', text: 'The buyer signed for the parcel.', verdict: 'supported', citations: [{ evidenceId: 'E7', fragments: ['E7.p8.l2'], quotes: ['Signed by J. D.'] }] },
        { id: 'S2', text: 'Order #10482 was paid.', verdict: 'supported', citations: [{ evidenceId: 'E1', fragments: [] }] },
      ],
      contradictions: [],
      analysis: { steps: ['a', 'b', 'c', 'd', 'e', 'f'], contradictionStep: 3, rejectionStep: 5, note: '' },
    };
    const serverInput = withUploadDocuments(buildInput(standardCase), uploads);
    const server = (confirmedCorrections: string[]) =>
      composeSubmission({ c, req: { evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {}, confirmedCorrections, attachments: [] }, verified: () => null, allowedActions: ['provide_evidence'], submitted: false, corrections: linesToConfirmOf(serverInput.documents) });
    const ctx: DraftContext = { edits: {}, checking: null, analysisStep: 6, rejectionStep: 5, contradictions: [], resolutions: {}, corrections: uploadCorrections(uploads) };
    const browser = (pairs: string[]) => deriveSentences(c.sentences, { ...ctx, confirmedCorrections: new Set(pairs) });

    for (const pairs of [[], ['S1@E7.p8.l1'], ['S2@E7.p8.l2'], ['S1@E7.l2']]) {
      const open = server(pairs);
      expect(isComposeProblem(open) && open.error).toBe('DRAFT_BLOCKED');
      expect(isComposeProblem(open) && open.blockers).toEqual(['sentence 1 needs review']);
    }
    const held = browser([])[0]!;
    expect(held.state).toBe('needs_review');
    expect(held.awaitsCorrections).toEqual(['E7.p8.l2']);
    expect(held.reason).toBe('Why: it depends on line 2 of page 8 of E7, transcribed manually by Ana Lopez (member) ("Signed by J. D."). Confirm it is what the file shows.');
    expect(correctionsToConfirm(held, uploadCorrections(uploads), new Set()).map((k) => k.fragment)).toEqual(['E7.p8.l2']);

    const ok = server(['S1@E7.p8.l2']);
    if (isComposeProblem(ok)) throw new Error(ok.detail);
    expect(browser(['S1@E7.p8.l2'])).toEqual(ok.views);
    expect(ok.views[0]!.note).toBe('Relies on line 2 of page 8 of E7 as transcribed manually by Ana Lopez (member)');
    // The pair the browser sends is the one the server parses, and it survives effectivePairs.
    const req = approvalRequest({ evidenceType: 'PROOF_OF_FULFILLMENT', edits: {}, resolutions: {}, views: ok.views, corrections: uploadCorrections(uploads), confirmed: ['S1@E7.p8.l2', 'S2@E7.p8.l2'], attachments: [] });
    expect(req.confirmedCorrections).toEqual(['S1@E7.p8.l2']);
    expect(parseIntentRequest(req)).toEqual(req);
  });

  it('a citation of a PDF says its page of the original document and who transcribed or corrected its lines, verbatim', () => {
    const e = uploadEvidence(confirmedPdf());
    expect(e.body.kind === 'lines' && e.body.lines[3]).toEqual({ text: 'Signed by J. D.', fragment: 'E7.p8.l2', transcribed: ANA });
    expect(citedCorrections(e, { evidenceId: 'E7', fragments: ['E7.p8.l1', 'E7.p8.l2'] })).toEqual([
      { line: 2, page: 8, fragment: 'E7.p8.l2', by: ANA, kind: 'transcribed', label: 'Page 8 of the original document · Transcribed manually by Ana Lopez (member)' },
    ]);
    expect(citedCorrections(e, { evidenceId: 'E7', fragments: ['E7.p2.l2'] })).toEqual([
      { line: 2, page: 2, fragment: 'E7.p2.l2', by: ANA, kind: 'corrected', label: 'Page 2 of the original document · line 2 corrected by Ana Lopez (member)' },
    ]);
    expect(provenanceOf(e)).toEqual({ kind: 'upload', text: 'Uploaded by Ana Lopez' });
    expect(provenanceOf(e, { evidenceId: 'E7', fragments: ['E7.p8.l1', 'E7.p8.l2'] })).toEqual({ kind: 'upload', text: 'Uploaded by Ana Lopez · Page 8 of the original document' });
    expect(provenanceOf(e, { evidenceId: 'E7', fragments: ['E7.p2.l2', 'E7.p8.l1'] })).toEqual({ kind: 'upload', text: 'Uploaded by Ana Lopez · Page 2 of the original document · Page 8 of the original document' });
    // Not a page-scoped citation: as before.
    expect(provenanceOf(uploadEvidence(confirmed()), { evidenceId: 'E7', fragments: ['E7.l2'] })).toEqual({ kind: 'upload', text: 'Uploaded by local operator' });
    expect(pageLabel(8)).toBe('Page 8 of the original document');
    expect(transcribedLabel(ANA)).toBe('Transcribed manually by Ana Lopez (member)');
  });

  it('a PDF attachment says who corrected and who transcribed its lines; a restricted view is never read', () => {
    const restricted = { id: 'upl-444444444444444444444444', caseId: standardCase.summary.id, kind: 'pdf', name: 'other.pdf', uploadedBy: { id: 'p2', label: 'Bo (member)', name: 'Bo' }, status: 'reviewing', createdAt: '2026-10-17T19:00:00.000Z', expiresAt: '2026-10-17T20:00:00.000Z', restricted: true } as unknown as UploadRecordView;
    const choices = attachmentChoices([restricted, confirmedPdf()], views([['S1', 'supported', ['E7']]]));
    expect(choices.map((c) => [c.evidenceId, c.corrected, c.selected])).toEqual([['E7', `lines corrected by ${ANA} · lines transcribed manually by ${ANA}`, true]]);
    expect([...uploadCorrections([restricted]).keys()]).toEqual([]);
    expect(withUploadDocuments(buildInput(standardCase), [restricted]).documents.some((d) => d.id === 'E7')).toBe(false);
  });
});

describe('evidenceCount', () => {
  it('counts the cards shown, confirmed uploads included', () => {
    const shown = [...standardCase.evidence, uploadEvidence(confirmed())];
    expect(evidenceCount(standardCase.evidence)).toBe(`${standardCase.evidence.length} documents`);
    expect(evidenceCount(shown)).toBe(`${standardCase.evidence.length + 1} documents`);
    expect(evidenceCount(shown.slice(0, 1))).toBe('1 document');
  });
});

/** The requests of the PDF methods, as the server's routes expect them (apps/server/src/uploads/routes.ts). */
describe('the uploads client, PDFs', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (body: unknown) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json(body);
    }) as unknown as typeof fetch;
  const client = (body: unknown = {}) => createUploadsClient('PP-1', { fetch: answer(body) });
  const ID = 'upl-0123456789abcdef01234567';

  it('uploadPdf sends the file as is with its type and its encoded name, and returns the upload', async () => {
    calls.length = 0;
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'factura ñ.pdf', { type: 'application/pdf' });
    const r = await client({ upload: { id: ID } }).uploadPdf(file);
    expect(r).toEqual({ upload: { id: ID } });
    expect(calls[0]!.url).toBe('/api/cases/PP-1/uploads');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: file });
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/pdf', 'x-upload-name': encodeURIComponent('factura ñ.pdf') });
  });

  it('select sends the chosen pages as JSON and returns the upload', async () => {
    calls.length = 0;
    const u = await client({ upload: { id: ID, status: 'pending' } }).select(ID, [2, 5, 8]);
    expect(u).toEqual({ id: ID, status: 'pending' });
    expect(calls[0]!.url).toBe(`/api/cases/PP-1/uploads/${ID}/select`);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: JSON.stringify({ pages: [2, 5, 8] }) });
  });

  it('redactPage and confirmPdf send the shapes of the routes', async () => {
    calls.length = 0;
    const c = client({ upload: { id: ID }, readLines: ['a'] });
    expect(await c.redactPage(ID, 2, [{ x: 1, y: 2, w: 30, h: 4 }])).toEqual({ upload: { id: ID }, readLines: ['a'] });
    expect(calls[0]!.url).toBe(`/api/cases/PP-1/uploads/${ID}/redact`);
    expect(calls[0]!.init.body).toBe(JSON.stringify({ page: 2, rects: [{ x: 1, y: 2, w: 30, h: 4 }] }));
    const pages = [{ lines: ['x'], added: [{ area: { x: 1, y: 1, w: 5, h: 5 }, text: 'y' }], sha256: 'b'.repeat(64) }];
    await c.confirmPdf(ID, pages);
    expect(calls[1]!.url).toBe(`/api/cases/PP-1/uploads/${ID}/confirm`);
    expect(calls[1]!.init.body).toBe(JSON.stringify({ pages }));
  });

  it('hint returns the text found in the page, and the image urls carry their version', async () => {
    calls.length = 0;
    const c = client({ lines: ['hidden', 'visible'] });
    expect(await c.hint(ID, 3)).toEqual(['hidden', 'visible']);
    expect(calls[0]!.url).toBe(`/api/cases/PP-1/uploads/${ID}/page/3/hint`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(c.pageUrl(ID, 3, 'sanitised', 'abcdef0123456789abcd')).toBe(`/api/cases/PP-1/uploads/${ID}/page/3?v=sanitised&k=abcdef0123456789`);
    expect(c.pageUrl(ID, 1, 'original', '')).toBe(`/api/cases/PP-1/uploads/${ID}/page/1?v=original`);
    expect(c.thumbUrl(ID, 12)).toBe(`/api/cases/PP-1/uploads/${ID}/thumb/12`);
  });

  it('a refused PDF carries the server code and words', async () => {
    const refused = (async () => Response.json({ error: 'UNREADABLE', detail: 'This file could not be read as a PDF.' }, { status: 422 })) as unknown as typeof fetch;
    await expect(createUploadsClient('PP-1', { fetch: refused }).uploadPdf(new File(['x'], 'a.pdf', { type: 'application/pdf' }))).rejects.toMatchObject({ status: 422, code: 'UNREADABLE', message: 'This file could not be read as a PDF.' });
  });
});

describe('a pending upload this person cannot edit (restricted)', () => {
  const restricted = (over: Partial<UploadRecordView> = {}): UploadRecordView => ({
    id: 'upl-fedcba9876543210fedcba98',
    kind: 'pdf',
    name: 'contract.pdf',
    uploadedBy: { id: 'p2', label: 'Eva (reviewer)', name: 'Eva' },
    status: 'pending',
    createdAt: '2026-10-18T10:00:00.000Z',
    expiresAt: '2026-10-18T11:00:00.000Z',
    restricted: true,
    pdf: { pageCount: 3, selected: [1, 2, 3], job: { state: 'reading', page: 1, of: 3 } },
    ...over,
  });

  it('is shown as «pending · name · uploaded by person», with no content and no review action', () => {
    expect(pendingLine(restricted())).toBe('pending · contract.pdf · uploaded by Eva');
    expect(canReviewUpload({ id: 'p1', role: 'member', reviewer: true }, restricted())).toBe(false);
    // Even for someone the role rules would let edit it: a restricted view has nothing to open.
    expect(canReviewUpload(null, restricted())).toBe(false);
    expect(canReviewUpload({ id: 'p1', role: 'owner', reviewer: false }, pending())).toBe(true);
  });

  it('takes no part in the analysis, the evidence, the attachments or the corrections', () => {
    const list = [restricted(), confirmed()];
    expect(confirmedUploads(list).map((u) => u.id)).toEqual([confirmed().id]);
    expect(withUploadDocuments({ documents: [] } as never, [restricted()])).toEqual({ documents: [] });
    expect(notAnalysed([restricted()], null)).toEqual([]);
    expect(attachmentChoices([restricted()], [])).toEqual([]);
    expect(uploadCorrections([restricted()]).size).toBe(0);
  });

  it('is kept by the list like any other pending upload', () => {
    const s = uploadsListReducer({ uploads: [], known: true, refused: null, error: null }, { type: 'loaded', uploads: [restricted()] });
    expect(s.uploads).toHaveLength(1);
  });
});
