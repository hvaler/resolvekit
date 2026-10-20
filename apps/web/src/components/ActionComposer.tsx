import { useState } from 'react';
import { CONTRACTS, statusLabel } from '../domain/actionContracts';
import { ACTION_TEXT_LIMIT, ESCALATE_CONSEQUENCE, acceptConsequenceText, offerConsequenceText, type ActionAvailability, type ActionRequest, type IntentAction, type Money } from '../domain/actions';
import { minorUnits, parseAmount } from '../domain/amounts';
import { formatCount } from '../domain/draft';
import { ACTION_LABEL } from '../domain/status';
import { confirmedUploads, type UploadRecordView } from '../domain/uploads';
import { PrimaryAction, cx } from './ui';

const VARIANT_LABEL: Partial<Record<string, string>> = {
  send_message: 'Message',
  'send_message:file': 'Message with a file',
  'accept_claim:REFUND': 'Full refund',
  'accept_claim:PARTIAL_REFUND': 'Partial refund',
  escalate: 'Escalate to a claim',
  'make_offer:REFUND': 'Refund offer',
  'make_offer:REPLACEMENT_WITHOUT_REFUND': 'Replacement offer',
};

/** Why a message cannot carry a file here: the uploads live on the ResolveKit server. */
const FILE_NEEDS_SERVER = 'attaching a file needs the ResolveKit server';

/**
 * The message request as the server composes it: the text, and the chosen upload while it is still a confirmed upload
 * of the case (deleted or no longer confirmed since it was chosen: none). At most one (send_message:file, W-3).
 */
export function messageRequest(text: string, attachment: string | null, uploads: readonly UploadRecordView[] | null | undefined): ActionRequest {
  const ok = !!attachment && confirmedUploads(uploads ?? []).some((u) => u.id === attachment);
  return { action: 'send_message', text, attachments: ok ? [attachment] : [] };
}

/**
 * An action other than evidence, as the merchant writes it: for a message, the text with its `n / 2,000` count and, when
 * the file variant is available, at most one of the case's confirmed uploads to attach; for an
 * accept, the type (full or partial refund), the partial amount and the note, with what PayPal does then; for an
 * escalation, the note and what PayPal does then; for an offer, the amount offered and the note, with what PayPal does
 * then (the buyer is offered it; nothing moves unless they accept); for every action, whether PayPal offers it now and each variant's
 * status as the contract registry gives it («Verified in sandbox», «Tested locally», «Not available: <reason>»). Only a sendable message,
 * accept or escalation can be reviewed; anyone else (a reviewer or a member, for an owner-only action) sees the preview
 * only.
 */
export function ActionComposer({
  action,
  text,
  onText,
  availability,
  locked,
  onReview,
  onRequest,
  disputeAmount = null,
  refundable = null,
  uploads,
  attachment = null,
  onAttachment,
}: {
  action: Exclude<IntentAction, 'provide_evidence'>;
  text: string;
  onText: (t: string) => void;
  availability: ActionAvailability;
  /** Why this person cannot send it here (signed out, another workspace), or null. */
  locked: string | null;
  onReview: () => void;
  /** An accept to review (the exact request the server composes). */
  onRequest?: (req: ActionRequest) => void;
  /** The dispute amount as last read: what a full accept refunds. */
  disputeAmount?: Money | null;
  /** PayPal's refundable amount as last read (an offer may not exceed it). */
  refundable?: Money | null;
  /** The case's uploads (only the confirmed ones are offered); null or absent: no server, so no file can be attached. */
  uploads?: readonly UploadRecordView[] | null;
  /** The upload chosen for the message (its id), or null. */
  attachment?: string | null;
  onAttachment?: (uploadId: string | null) => void;
}) {
  const isMessage = action === 'send_message';
  const len = text.trim().length;
  const over = len > ACTION_TEXT_LIMIT;
  const canReview = isMessage && availability.sendable && !locked && len > 0 && !over;
  const label = ACTION_LABEL[action];
  const fileVariant = availability.variants.find((v) => v.variant === 'send_message:file');
  const offerFile = isMessage && availability.sendable && !!fileVariant?.available && uploads != null;
  const files = offerFile ? confirmedUploads(uploads) : [];
  const chosen = files.some((u) => u.id === attachment) ? attachment : null;
  const variantText = (v: ActionAvailability['variants'][number]): string => {
    if (!v.variant) return `Not available: ${v.why ?? ''}`;
    // The file variant needs the server's uploads, and says why it is not available (e.g. the simulator's state).
    if (v.variant === 'send_message:file' && uploads == null) return `Not available: ${FILE_NEEDS_SERVER}`;
    if (v.variant === 'send_message:file' && !v.available) return `Not available: ${v.why ?? ''}`;
    return statusLabel(CONTRACTS[v.variant]);
  };
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="m-0 text-[12.5px] font-semibold">{label}</h3>
      <ul aria-label={`${label}: availability`} className="m-0 flex list-none flex-col gap-1 p-0 text-[11.5px]">
        {availability.variants.map((v) => (
          <li key={`${v.variant}|${v.type}`} className={v.available && (v.variant !== 'send_message:file' || uploads != null) ? 'text-ok' : 'text-ink-3'}>
            {`${(v.variant && VARIANT_LABEL[v.variant]) ?? v.type ?? label} · ${variantText(v)}`}
          </li>
        ))}
      </ul>
      {!availability.sendable && availability.why && (
        <p role="note" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          Not available: {availability.why}
        </p>
      )}
      {isMessage && (
        <>
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-[12.5px]">
              <span className="font-medium">Message to the buyer</span>
              <span className={cx('font-mono text-[12px]', over ? 'text-bad' : 'text-ink-2')}>
                {`${formatCount(len)} / ${formatCount(ACTION_TEXT_LIMIT)}`}
              </span>
            </span>
            <textarea
              aria-label="Message to the buyer"
              value={text}
              onChange={(e) => onText(e.target.value)}
              rows={5}
              disabled={!availability.sendable}
              className="resize-y rounded-[7px] border border-line-2 bg-surface px-2.5 py-2 text-body leading-normal text-ink disabled:opacity-60"
            />
          </label>
          <span className="text-[11.5px] text-ink-3">The buyer sees exactly this text in PayPal. You review it before it is sent.</span>
          {offerFile && (
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-label="Attach a file">
              <legend className="mb-1 text-[12.5px] font-medium">Attach a file (optional, at most one)</legend>
              {files.length === 0 ? (
                <span className="text-[12px] text-ink-3">No confirmed upload of this case to attach. Confirmed evidence uploads can be attached here.</span>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <input type="radio" name="message-file" value="" checked={chosen === null} disabled={!!locked} onChange={() => onAttachment?.(null)} />
                    No file
                  </label>
                  {files.map((u) => (
                    <label key={u.id} className="flex items-center gap-2 text-[12.5px]">
                      <input type="radio" name="message-file" value={u.id} checked={chosen === u.id} disabled={!!locked} onChange={() => onAttachment?.(u.id)} />
                      <span>
                        <span className="font-mono text-mono-frag">{u.evidenceId}</span> {u.name} · Uploaded by {u.uploadedBy.name}
                      </span>
                    </label>
                  ))}
                  <span className="text-[11.5px] text-ink-3">The file goes to PayPal as the covered file you confirmed. You see it again in the review.</span>
                </>
              )}
            </fieldset>
          )}
          {locked && <span className="text-[12px] text-warn">{locked}</span>}
          <PrimaryAction enabled={canReview} onClick={onReview}>
            Review the message →
          </PrimaryAction>
        </>
      )}
      {action === 'accept_claim' && <AcceptComposer availability={availability} locked={locked} disputeAmount={disputeAmount} onRequest={onRequest} />}
      {action === 'escalate' && <EscalateComposer availability={availability} locked={locked} onRequest={onRequest} />}
      {action === 'make_offer' && <OfferComposer availability={availability} locked={locked} disputeAmount={disputeAmount} refundable={refundable} onRequest={onRequest} />}
    </section>
  );
}

/** The accept types ResolveKit can send, in the order offered here. */
const ACCEPT_TYPES: readonly string[] = ['REFUND', 'PARTIAL_REFUND'];

/**
 * An accept: full refund (PayPal refunds the disputed amount and closes the dispute) or partial refund (PayPal offers
 * the amount to the buyer, who must agree). The two are shown apart, each with its own consequence; the preview is
 * shown to everyone, the review button only to whoever may send it.
 */
function AcceptComposer({
  availability,
  locked,
  disputeAmount,
  onRequest,
}: {
  availability: ActionAvailability;
  locked: string | null;
  disputeAmount: Money | null;
  onRequest: ((req: ActionRequest) => void) | undefined;
}) {
  // Variants PayPal allows now and the registry has recorded; for a viewer who may not send, the same choice as a preview.
  const types = ACCEPT_TYPES.filter((t) => availability.variants.some((v) => v.type === t && v.available));
  const [picked, setPicked] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const type = picked && types.includes(picked) ? picked : (types[0] ?? null);
  if (!type) return null;
  const owner = availability.sendable;
  const currency = disputeAmount?.currency ?? null;
  const parsed = type === 'PARTIAL_REFUND' && currency && value.trim() ? parseAmount(value.trim(), currency) : null;
  const partialAmount: Money | null = parsed?.ok && currency ? { value: parsed.value, currency } : null;
  const amount = type === 'REFUND' ? disputeAmount : partialAmount;
  const noteLen = note.trim().length;
  const noteOver = noteLen > ACTION_TEXT_LIMIT;
  // A note is required in this delivery (no accept without one was recorded).
  const ready = owner && !locked && noteLen > 0 && !noteOver && (type === 'REFUND' ? !!disputeAmount : !!partialAmount);
  return (
    <>
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-[12.5px] font-medium">How to accept</legend>
        {types.map((t) => (
          <label key={t} className="flex items-center gap-2 text-[12.5px]">
            <input type="radio" name="accept-type" value={t} checked={t === type} onChange={() => setPicked(t)} />
            {t === 'REFUND'
              ? `Full refund${disputeAmount ? ` of ${disputeAmount.value} ${disputeAmount.currency}` : ''}: the dispute closes`
              : 'Partial refund: an offer the buyer must agree to'}
          </label>
        ))}
      </fieldset>
      {type === 'PARTIAL_REFUND' && (
        <label className="flex flex-col gap-1 text-[12.5px]">
          <span className="font-medium">Amount offered{disputeAmount ? ` (${disputeAmount.currency}, below ${disputeAmount.value})` : ''}</span>
          <input
            aria-label="Amount offered"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!owner}
            className="rounded-[7px] border border-line-2 bg-surface px-2.5 py-1.5 font-mono text-body text-ink disabled:opacity-60"
          />
          {parsed && !parsed.ok && <span className="text-[12px] text-bad">{parsed.detail}</span>}
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-[12.5px]">
          <span className="font-medium">Note to PayPal</span>
          <span className={cx('font-mono text-[12px]', noteOver ? 'text-bad' : 'text-ink-2')}>{`${formatCount(noteLen)} / ${formatCount(ACTION_TEXT_LIMIT)}`}</span>
        </span>
        <textarea
          aria-label="Note to PayPal"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          disabled={!owner}
          className="resize-y rounded-[7px] border border-line-2 bg-surface px-2.5 py-2 text-body leading-normal text-ink disabled:opacity-60"
        />
      </label>
      <p data-testid="accept-consequence" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
        {acceptConsequenceText(type, amount)}
      </p>
      {locked && <span className="text-[12px] text-warn">{locked}</span>}
      {owner && (
        <PrimaryAction
          enabled={ready && !!onRequest}
          onClick={() => onRequest?.({ action: 'accept_claim', acceptType: type, note: note.trim(), amount: type === 'PARTIAL_REFUND' ? partialAmount : null, attachments: [] })}
        >
          Review the accept →
        </PrimaryAction>
      )}
    </>
  );
}

/**
 * An escalation: the note to PayPal (required, at most 2,000 characters) and what happens then, shown to everyone while
 * the recorded variant is available; the review button only to whoever may send it (the owner).
 */
function EscalateComposer({ availability, locked, onRequest }: { availability: ActionAvailability; locked: string | null; onRequest: ((req: ActionRequest) => void) | undefined }) {
  const [note, setNote] = useState('');
  if (!availability.variants.some((v) => v.variant === 'escalate' && v.available)) return null;
  const owner = availability.sendable;
  const len = note.trim().length;
  const over = len > ACTION_TEXT_LIMIT;
  const ready = owner && !locked && len > 0 && !over;
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-[12.5px]">
          <span className="font-medium">Note to PayPal</span>
          <span className={cx('font-mono text-[12px]', over ? 'text-bad' : 'text-ink-2')}>{`${formatCount(len)} / ${formatCount(ACTION_TEXT_LIMIT)}`}</span>
        </span>
        <textarea
          aria-label="Note to PayPal"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          disabled={!owner}
          className="resize-y rounded-[7px] border border-line-2 bg-surface px-2.5 py-2 text-body leading-normal text-ink disabled:opacity-60"
        />
      </label>
      <p data-testid="escalate-consequence" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
        {ESCALATE_CONSEQUENCE}
      </p>
      {locked && <span className="text-[12px] text-warn">{locked}</span>}
      {owner && (
        <PrimaryAction enabled={ready && !!onRequest} onClick={() => onRequest?.({ action: 'escalate', note: note.trim(), attachments: [] })}>
          Review the escalation →
        </PrimaryAction>
      )}
    </>
  );
}

/**
 * A refund offer (W-4): the amount offered (more than 0 and below the dispute amount; a full-amount offer was not
 * verified with PayPal) and the note to PayPal (required, at most 2,000 characters), with what happens then: the buyer
 * is offered the amount, and no money moves unless the buyer accepts. Shown to everyone while the recorded variant is
 * available; the review button only to whoever may send it (the owner).
 */
function OfferComposer({
  availability,
  locked,
  disputeAmount,
  refundable,
  onRequest,
}: {
  availability: ActionAvailability;
  locked: string | null;
  disputeAmount: Money | null;
  refundable: Money | null;
  onRequest: ((req: ActionRequest) => void) | undefined;
}) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  if (!availability.variants.some((v) => v.variant === 'make_offer:REFUND' && v.available)) return null;
  const owner = availability.sendable;
  const currency = disputeAmount?.currency ?? null;
  const parsed = currency && value.trim() ? parseAmount(value.trim(), currency) : null;
  const amount: Money | null = parsed?.ok && currency ? { value: parsed.value, currency } : null;
  const len = note.trim().length;
  const over = len > ACTION_TEXT_LIMIT;
  const ready = owner && !locked && !!amount && len > 0 && !over;
  const bound = !disputeAmount ? '' : lowerCap(refundable, disputeAmount) ? ` (${disputeAmount.currency}, at most ${refundable!.value}, what PayPal would refund)` : ` (${disputeAmount.currency}, below ${disputeAmount.value})`;
  return (
    <>
      <label className="flex flex-col gap-1 text-[12.5px]">
        <span className="font-medium">Amount offered{bound}</span>
        <input
          aria-label="Amount offered"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!owner}
          className="rounded-[7px] border border-line-2 bg-surface px-2.5 py-1.5 font-mono text-body text-ink disabled:opacity-60"
        />
        {parsed && !parsed.ok && <span className="text-[12px] text-bad">{parsed.detail}</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-[12.5px]">
          <span className="font-medium">Note to PayPal</span>
          <span className={cx('font-mono text-[12px]', over ? 'text-bad' : 'text-ink-2')}>{`${formatCount(len)} / ${formatCount(ACTION_TEXT_LIMIT)}`}</span>
        </span>
        <textarea
          aria-label="Note to PayPal"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          disabled={!owner}
          className="resize-y rounded-[7px] border border-line-2 bg-surface px-2.5 py-2 text-body leading-normal text-ink disabled:opacity-60"
        />
      </label>
      <p data-testid="offer-consequence" className="m-0 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
        {offerConsequenceText(amount)}
      </p>
      {locked && <span className="text-[12px] text-warn">{locked}</span>}
      {owner && (
        <PrimaryAction enabled={ready && !!onRequest} onClick={() => amount && onRequest?.({ action: 'make_offer', offerType: 'REFUND', note: note.trim(), amount, attachments: [] })}>
          Review the offer →
        </PrimaryAction>
      )}
    </>
  );
}

/** PayPal's refundable amount is below the dispute amount (same currency, minor units): the offer's real cap. */
function lowerCap(refundable: Money | null, dispute: Money): boolean {
  if (!refundable || refundable.currency !== dispute.currency) return false;
  try {
    return minorUnits(refundable.value, refundable.currency) < minorUnits(dispute.value, dispute.currency);
  } catch {
    return false;
  }
}
