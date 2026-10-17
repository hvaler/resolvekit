import type { ActingPerson } from '../app.ts';
import type { UploadRecord } from './store.ts';

/** Redact, correct, confirm: owners and members any upload; a reviewer only their own. An owner is never limited. */
export const canEditUpload = (p: ActingPerson, u: UploadRecord): boolean => p.role === 'owner' || !p.reviewer || p.id === u.uploadedBy.id;

/** Delete: owners and members only; a reviewer discards before confirming but never deletes. */
export const canDeleteUpload = (p: ActingPerson): boolean => p.role === 'owner' || !p.reviewer;
