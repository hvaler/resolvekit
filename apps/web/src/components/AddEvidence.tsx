import { useState } from 'react';
import { UploadRequestError, type ReadAnswer, type UploadRecordView, type UploadsClient } from '../domain/uploads';
import { Button, MiniButton, Spinner } from './ui';

const message = (e: unknown) => (e instanceof UploadRequestError || e instanceof Error ? e.message : String(e));

/** Choose an image (PNG, JPEG) or paste text; the server reads it and the review opens. */
export function AddEvidencePanel({ client, onAdded, onClose }: { client: UploadsClient; onAdded: (a: ReadAnswer, pastedText: string | null) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<null | 'image' | 'text'>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: 'image' | 'text', f: () => Promise<ReadAnswer>, pasted: string | null) => {
    setBusy(what);
    setError(null);
    try {
      onAdded(await f(), pasted);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Add evidence" className="flex flex-col gap-2.5 rounded-2xl border border-acc-line bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-[13.5px] font-semibold">Add evidence</h3>
        <button type="button" onClick={onClose} disabled={!!busy} className="border-0 bg-transparent p-0 text-[12px] text-ink-2 underline">
          Cancel
        </button>
      </div>
      <p className="m-0 text-[12.5px] text-ink-2">
        It is read on this server only. Nothing of it is used, sent to an AI model or to PayPal until you have covered what must not be shared and confirmed it.
      </p>
      <label className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-medium">A screenshot (PNG or JPEG, up to 5 MB)</span>
        <input
          type="file"
          accept="image/png,image/jpeg"
          disabled={!!busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void run('image', () => client.uploadImage(file), null);
          }}
          className="text-[12.5px]"
        />
        {busy === 'image' && (
          <span role="status" className="flex items-center gap-1.5 text-ink-2">
            <Spinner size={14} /> Reading the image…
          </span>
        )}
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="paste-evidence" className="text-[12.5px] font-medium">
          Or paste text (an email thread, a chat)
        </label>
        <textarea id="paste-evidence" rows={4} value={text} disabled={!!busy} onChange={(e) => setText(e.target.value)} className="box-border w-full resize-y rounded-lg border border-line-2 bg-surface px-2.5 py-2 font-mono text-mono-frag" />
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Name of the pasted text" placeholder="Name, e.g. buyer email 9 Oct" value={name} disabled={!!busy} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line-2 bg-surface px-2 py-1 text-[12.5px]" />
          <Button className="h-8 text-[12.5px]" disabled={!!busy || !text.trim()} onClick={() => void run('text', () => client.uploadText(text, name.trim() || 'pasted text'), text)}>
            {busy === 'text' ? 'Adding…' : 'Add pasted text'}
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded-xl border border-bad-line bg-bad-soft px-3 py-2 text-body">
          {error}
        </div>
      )}
    </section>
  );
}

/** Uploads not confirmed yet: listed, never used, until reviewed. */
export function PendingUploads({
  uploads,
  canEdit,
  onReview,
  onDiscard,
}: {
  uploads: UploadRecordView[];
  /** Whether this person may review and discard it (domain/uploads `canEditUpload`, the server's rule). */
  canEdit: (u: UploadRecordView) => boolean;
  onReview: (u: UploadRecordView) => void;
  onDiscard: (u: UploadRecordView) => void;
}) {
  if (!uploads.length) return null;
  return (
    <ul aria-label="Uploads to review" className="m-0 flex list-none flex-col gap-2 p-0">
      {uploads.map((u) => (
        <li key={u.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-2xl border border-dashed border-warn-line bg-warn-soft px-4 py-2.5">
          <span className="rounded-sm bg-surface px-1.5 py-1 font-mono text-[11px] font-semibold leading-none text-warn">New · pending</span>
          <span className="min-w-[10rem] flex-1 text-[13.5px] font-semibold">{u.name}</span>
          <span className="text-[12px] text-warn">Not used yet: review it first</span>
          {canEdit(u) ? (
            <>
              <MiniButton onClick={() => onReview(u)}>Review</MiniButton>
              <MiniButton onClick={() => onDiscard(u)}>Discard</MiniButton>
            </>
          ) : (
            <span className="text-[12px] text-ink-3">Uploaded by {u.uploadedBy.name}: only they, an owner or a member can review it</span>
          )}
        </li>
      ))}
    </ul>
  );
}
