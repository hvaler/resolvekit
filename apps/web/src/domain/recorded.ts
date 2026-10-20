import { CONTRACTS } from './actionContracts.ts';
import type { ContractRegistry } from './actions.ts';
import type { CaseFile, DisputeSnapshot, EvidenceSubmission, RecordedEvidence, TimelineItem } from './types';

/**
 * Evidence the merchant submitted, as PayPal reports it. A real dispute also lists the buyer's own entry
 * (CREATE, SUBMITTED_BY_BUYER) and what PayPal requests (REQUESTED_FROM_SELLER); neither is the merchant's
 * evidence. When PayPal reports `action_info.action`, it must be PROVIDE_EVIDENCE.
 */
export function isSellerSubmission(e: RecordedEvidence): boolean {
  return e.source === 'SUBMITTED_BY_SELLER' && (e.action == null || e.action === 'PROVIDE_EVIDENCE');
}

export function sellerEvidence(s: DisputeSnapshot): RecordedEvidence[] {
  return s.evidences.filter(isSellerSubmission);
}

/** PayPal shows evidence submitted by the seller on this dispute. */
export function hasSellerEvidence(s: DisputeSnapshot): boolean {
  return s.evidences.some(isSellerSubmission);
}

/** Evidence by stage needs the recorded variant (W-6): each entry carries the stage it was made in. */
const byStageRecorded = (contracts: Pick<ContractRegistry, 'evidence:after_escalation'>): boolean => contracts['evidence:after_escalation'].status !== 'not_available';

/**
 * PayPal shows seller evidence that blocks more evidence now. With `evidence:after_escalation` recorded (W-6), only
 * evidence in the dispute's current stage does (PayPal's `dispute_life_cycle_stage` on the entry): evidence sent in the
 * inquiry does not block the claim. An entry without a stage, or a dispute without one, blocks the whole dispute, as
 * does any seller evidence while that variant is not recorded. The ESCALATE entry is never evidence.
 */
export function sellerEvidenceBlocks(s: DisputeSnapshot, contracts: Pick<ContractRegistry, 'evidence:after_escalation'> = CONTRACTS): boolean {
  if (!byStageRecorded(contracts)) return hasSellerEvidence(s);
  return sellerEvidence(s).some((e) => !e.stage || !s.stage || e.stage === s.stage);
}

/** The seller escalated this dispute: PayPal shows the seller's ESCALATE entry (W-5). */
export const sellerEscalated = (s: DisputeSnapshot): boolean => s.evidences.some((e) => e.source === 'SUBMITTED_BY_SELLER' && e.action === 'ESCALATE');

/** The state W-6 sent evidence from after the escalation: the claim, waiting for the seller. */
const AFTER_ESCALATION = { stage: 'CHARGEBACK', status: 'WAITING_FOR_SELLER_RESPONSE' } as const;

/**
 * Why evidence cannot be sent on this dispute after the seller's escalation ([A2]), or null: only the recorded variant,
 * and only from the state it was recorded from (not, e.g., the inquiry under review whose links flicker after W-5).
 * A dispute the seller did not escalate keeps the existing evidence flow.
 */
export function evidenceAfterEscalationRefusal(s: DisputeSnapshot, contracts: Pick<ContractRegistry, 'evidence:after_escalation'> = CONTRACTS): string | null {
  if (!sellerEscalated(s)) return null;
  const c = contracts['evidence:after_escalation'];
  if (c.status === 'not_available') return `Not available: ${c.reason ?? 'Contract not recorded yet'}`;
  if (s.stage !== AFTER_ESCALATION.stage || s.status !== AFTER_ESCALATION.status) {
    return 'Not available: after an escalation, evidence was verified with PayPal only once the claim waits for the seller';
  }
  return null;
}

/** An evidence entry's identity: who, what, when and its content, as PayPal reports it. */
export const evidenceKey = (e: RecordedEvidence): string => JSON.stringify([e.source, e.action ?? null, e.evidenceType, e.date ?? e.storedAt, e.tracking, [...e.files].sort(), e.notes]);

/**
 * Seller evidence that PayPal shows now and did not show in `before` (the dispute as read before sending).
 * Only this can be reported as "recorded": evidence already on the dispute is not proof of this submission.
 * Returns the latest such entry, or null.
 */
export function newSellerEvidence(after: DisputeSnapshot, before: DisputeSnapshot): RecordedEvidence | null {
  const seen = new Set(sellerEvidence(before).map(evidenceKey));
  const fresh = sellerEvidence(after).filter((e) => !seen.has(evidenceKey(e)));
  return fresh.length ? (fresh[fresh.length - 1] ?? null) : null;
}

/**
 * Which fields of a seller entry differ from what we sent: evidence type, notes (full text), tracking (when we sent a
 * carrier and a reference) and file names. Empty: the entry is our submission as PayPal stored it.
 */
export function submissionMismatch(sent: EvidenceSubmission, e: RecordedEvidence): string[] {
  const out: string[] = [];
  if (e.evidenceType !== sent.evidenceType) out.push('evidence type');
  if (e.notes !== sent.notes) out.push('notes');
  if (sent.carrier && sent.tracking && (e.tracking !== sent.tracking || e.carrier !== sent.carrier)) out.push('tracking');
  const files = sent.files.map((f) => f.name);
  if (files.length !== e.files.length || !files.every((f) => e.files.includes(f))) out.push('files');
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number) => String(n).padStart(2, '0');
/** "26 Sep 11:05" (UTC), the timeline's format for multi-day cases. */
function dayTime(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * What happened at PayPal after the documents, from the dispute as read: the seller's evidence going in and the
 * outcome. Appended to the analyst's timeline (which is built from the documents only), labelled by who recorded it.
 */
export function payPalEvents(s: DisputeSnapshot, by: 'PayPal' | 'the simulator'): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const e of sellerEvidence(s)) {
    const t = e.date ? dayTime(e.date) : null;
    if (t) out.push({ kind: 'event', time: t, title: 'Evidence sent', sub: `${e.evidenceType} · recorded by ${by}`, tag: 'PP', evidenceId: null });
  }
  const closed = s.status === 'RESOLVED' && s.outcome?.closedAt ? dayTime(s.outcome.closedAt) : null;
  if (closed) out.push({ kind: 'event', time: closed, title: 'Dispute closed', sub: `${s.outcome!.code} · ${by}`, tag: 'PP', evidenceId: null });
  return out;
}

/**
 * Whether a case starts further on at PayPal (evidence already on the dispute, or an outcome): only then does the
 * case page add PayPal's later events to its timeline. A thread alone (the standard case's buyer message) is not that,
 * so a fresh case's timeline is the analysis's, as before.
 */
export function startsFurtherOn(c: Pick<CaseFile, 'simulatedPayPal'>): boolean {
  const s = c.simulatedPayPal;
  return !!s && (s.evidences.length > 0 || !!s.outcome);
}
