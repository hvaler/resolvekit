import type { Environment } from './environment';

/** The owner's wording for the three environments, verbatim. */
export const ENVIRONMENTS_HELP = [
  'Explore demo: fictional cases on a simulator. Nothing is sent to PayPal.',
  'Sandbox evaluation: invited people only. Test documents go to PayPal sandbox disputes; no real money moves.',
  'Your merchant space: your own disputes and evidence, once the dispute connection is validated and available.',
] as const;

export const CHECKING_TEXT = 'Checking your PayPal connection…';
export const HEALTH_RETRY_TEXT = "Couldn't read the bound sandbox cases yet. Retrying…";
export const SANDBOX_WARNING = 'This sends test documents to a PayPal sandbox dispute. No real money moves.';
export const DEMO_UPLOAD_REASON = "Adding your own evidence reads it on the ResolveKit server; it's available in the sandbox evaluation, not in the demo.";

/** The merchant waiting screen's lines: the owner and the members read different first lines. */
export function waitingCopy(env: { kind: 'merchant'; owner: boolean }): { status: string; explanation: string; demoButton: string; demoNote: string; invitesNote: string } {
  return {
    status: env.owner ? "You're signed in with PayPal. Access to your disputes isn't available yet." : "This workspace isn't connected to its PayPal disputes yet.",
    explanation:
      "Connecting disputes for new merchants is being validated and isn't available yet. For now, ResolveKit can't read your disputes or send responses on your business's behalf.",
    demoButton: 'Explore demo',
    demoNote: 'Try the full flow on fictional cases. Nothing you do in the demo is sent to PayPal.',
    invitesNote: "Inviting someone doesn't connect your disputes to PayPal.",
  };
}

/** The warning before submitting, only for an evaluation case that goes to the PayPal sandbox. */
export function sandboxNotice(kind: Environment['kind'], payPalEnv: string | null): string | null {
  return kind === 'evaluation' && payPalEnv === 'sandbox' ? SANDBOX_WARNING : null;
}

/** The app bar's environment indicator; the local single-user mode has none. */
export function environmentLabel(env: Environment, workspaceName: string | null): string | null {
  if (env.kind === 'demo') return 'Explore demo · fictional cases, nothing is sent';
  if (env.kind === 'evaluation') return `Sandbox evaluation · ${workspaceName ?? env.workspace} · PayPal sandbox`;
  return null;
}
