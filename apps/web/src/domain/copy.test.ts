import { describe, expect, it } from 'vitest';
import { DEMO_UPLOAD_REASON, ENVIRONMENTS_HELP, environmentLabel, sandboxNotice, waitingCopy } from './copy';

describe('copy', () => {
  it('owner and member waiting lines (verbatim)', () => {
    const owner = waitingCopy({ kind: 'merchant', owner: true });
    const member = waitingCopy({ kind: 'merchant', owner: false });
    expect(owner.status).toBe("You're signed in with PayPal. Access to your disputes isn't available yet.");
    expect(member.status).toBe("This workspace isn't connected to its PayPal disputes yet.");
    expect(owner.explanation).toBe(
      "Connecting disputes for new merchants is being validated and isn't available yet. For now, ResolveKit can't read your disputes or send responses on your business's behalf.",
    );
    expect(owner.demoButton).toBe('Explore demo');
    expect(owner.demoNote).toBe('Try the full flow on fictional cases. Nothing you do in the demo is sent to PayPal.');
    expect(owner.invitesNote).toBe("Inviting someone doesn't connect your disputes to PayPal.");
  });
  it('sandboxNotice only for evaluation on sandbox', () => {
    const text = 'This sends test documents to a PayPal sandbox dispute. No real money moves.';
    expect(sandboxNotice('evaluation', 'sandbox')).toBe(text);
    for (const kind of ['demo', 'local', 'merchant', 'checking', 'signed-out'] as const) expect(sandboxNotice(kind, 'sandbox')).toBeNull();
    expect(sandboxNotice('evaluation', 'live')).toBeNull();
    expect(sandboxNotice('evaluation', null)).toBeNull();
  });
  it('environmentLabel for demo and evaluation (verbatim), null for local', () => {
    expect(environmentLabel({ kind: 'demo' }, null)).toBe('Explore demo · fictional cases, nothing is sent');
    expect(environmentLabel({ kind: 'evaluation', workspace: 'Test Store' }, 'Test Store')).toBe('Sandbox evaluation · Test Store · PayPal sandbox');
    expect(environmentLabel({ kind: 'local' }, null)).toBeNull();
  });
  it('demo upload reason (verbatim)', () => {
    expect(DEMO_UPLOAD_REASON).toBe("Adding your own evidence reads it on the ResolveKit server; it's available in the sandbox evaluation, not in the demo.");
  });
  it('environments help has the three lines (verbatim)', () => {
    expect([...ENVIRONMENTS_HELP]).toEqual([
      'Explore demo: fictional cases on a simulator. Nothing is sent to PayPal.',
      'Sandbox evaluation: invited people only. Test documents go to PayPal sandbox disputes; no real money moves.',
      'Your merchant space: your own disputes and evidence, once the dispute connection is validated and available.',
    ]);
  });
});
