import { describe, expect, it } from 'vitest';
import { DemoClient, lockedReason, type DemoState } from './demoClient';

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

describe('DemoClient', () => {
  it('has no lock on a local server (404) or without a server', async () => {
    expect(await new DemoClient({ fetch: reply(404, { error: 'NOT_FOUND' }) }).state()).toBeNull();
    expect(await new DemoClient({ fetch: (async () => { throw new TypeError('down'); }) as typeof fetch }).state()).toBeNull();
  });

  it('reads the hosted lock', async () => {
    const s = await new DemoClient({ fetch: reply(200, { hosted: true, unlockable: true, unlocked: false, expiresAt: null, reasons: { evidence: 'Needs the code.' }, caps: {} }) }).state();
    expect(s).toMatchObject({ unlockable: true, unlocked: false, reasons: { evidence: 'Needs the code.' } });
  });

  it('unlock: wrong code, too many attempts, success', async () => {
    expect(await new DemoClient({ fetch: reply(403, { error: 'BAD_DEMO_CODE' }) }).unlock('x')).toEqual({ ok: false, error: 'That is not the demo code.' });
    expect(await new DemoClient({ fetch: reply(429, { error: 'RATE_LIMITED', detail: 'Too many attempts; try again in 15 min' }) }).unlock('x')).toEqual({ ok: false, error: 'Too many attempts; try again in 15 min' });
    const ok = await new DemoClient({ fetch: reply(200, { hosted: true, unlockable: true, unlocked: true, expiresAt: '2026-10-09T20:00:00.000Z', reasons: {}, caps: {} }) }).unlock('code');
    expect(ok.ok && ok.state.unlocked).toBe(true);
  });

  it('lockedReason: only while locked on a hosted server', () => {
    const locked: DemoState = { unlockable: true, unlocked: false, expiresAt: null, reasons: { evidence: 'Cannot be undone.' }, caps: {} };
    expect(lockedReason(locked, 'evidence')).toBe('Cannot be undone.');
    expect(lockedReason(locked, 'recheck')).toBe('This action needs the demo code.');
    expect(lockedReason({ ...locked, unlocked: true }, 'evidence')).toBeNull();
    expect(lockedReason(null, 'evidence')).toBeNull();
  });
});
