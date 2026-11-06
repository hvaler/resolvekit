/**
 * Discovered cases on screen: a new PayPal dispute from a ResolveKit order that the server made into its own case
 * (webhook or the owner's «Find new disputes»). Which case file a case id opens, the case's provenance line, who may
 * look for new disputes and what that search says. Pure and React-free, so the rules are tested directly.
 */
import { utcDateTime, type CaseTemplate } from '@resolvekit/cases';
import type { DemoState } from './demoClient';
import type { Area } from './environment';
import { GatewayTimeoutError } from './gateway';
import { GatewayRequestError, type DiscoveredCaseInfo, type ScanResult, type ServerHealth } from './httpGateway';

/**
 * The template of each discovered case this viewer may open, from the server's `/api/health`. The Explore demo never
 * opens one (simulated templates only), whatever the server lists.
 */
export function templateOfCase(area: Area, health: ServerHealth | null): (caseId: string) => CaseTemplate | null {
  const cases = area === 'demo' ? undefined : health?.cases;
  return (caseId) => (cases && Object.hasOwn(cases, caseId) ? cases[caseId]!.template : null);
}

/** The discovered case's record in `/api/health`, or null (a fixed case, or not listed for this viewer). */
export function discoveredInfo(area: Area, health: ServerHealth | null, caseId: string): DiscoveredCaseInfo | null {
  const cases = area === 'demo' ? undefined : health?.cases;
  return cases && Object.hasOwn(cases, caseId) ? cases[caseId]! : null;
}

const SOURCE_TEXT: Readonly<Record<DiscoveredCaseInfo['source'], string>> = { webhook: 'webhook', scan: 'owner scan' };

/**
 * «Discovered from PayPal (webhook) · dispute PP-R-… · capture 7XK… · order rk-std-… · 6 Nov 2026 10:04 UTC». The
 * capture is the one PayPal reports on the dispute; «—» until that read is in.
 */
export function provenanceText(caseId: string, c: DiscoveredCaseInfo, captureId: string | null | undefined): string {
  return [
    `Discovered from PayPal (${SOURCE_TEXT[c.source]})`,
    `dispute ${caseId}`,
    `capture ${captureId || '—'}`,
    `order ${c.orderRef}`,
    utcDateTime(c.createdAt) ?? c.createdAt,
  ].join(' · ');
}

/** «Find new disputes» is the owner's, in the evaluation workspace only (not members, reviewers, signed out, the demo). */
export function canFindDisputes(area: Area, demo: DemoState | null): boolean {
  return area !== 'demo' && !!demo?.signedIn && demo.workspace?.connection === 'evaluation' && demo.person?.role === 'owner' && !demo.person.reviewer;
}

/** «Found 1 new · 2 skipped», with each skipped dispute and why on hover (null when none was skipped). */
export function scanResultText(r: ScanResult): { text: string; title: string | null } {
  return {
    text: `Found ${r.created.length} new · ${r.skipped.length} skipped`,
    title: r.skipped.length ? r.skipped.map((s) => `${s.disputeId}: ${s.why}`).join('\n') : null,
  };
}

const PAYPAL_DOWN = 'PayPal unavailable · try again in a moment';

/** Why the search did not run: too soon (when to try again), PayPal unavailable, or the server's own words. */
export function scanErrorText(e: unknown): string {
  if (e instanceof GatewayTimeoutError) return PAYPAL_DOWN;
  if (e instanceof GatewayRequestError) {
    if (e.status === 429) {
      const s = Number(e.body.retryAfterSec);
      return Number.isFinite(s) && s > 0 ? `Looked a moment ago · try again in ${Math.ceil(s)} s` : 'Looked a moment ago · try again in a minute';
    }
    if (e.status === 503) return PAYPAL_DOWN;
  }
  return `Couldn’t look for new disputes: ${e instanceof Error ? e.message : String(e)}`;
}
