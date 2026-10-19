/**
 * How the upload limits read in the messages people see: each as it is defined in uploads/limits.ts (a binary limit in
 * MiB, a decimal one in MB), so the app, its refusals and the docs name the same number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILE_BYTES, MAX_STORAGE_BYTES, MAX_STORED_BYTES, PAYPAL_MAX_SEND_BYTES, PDF_MAX_BYTES, sizeLimitText } from '../src/uploads/limits.ts';
import { TOO_BIG } from '../src/uploads/pdf-input.ts';
import { P, TIMEOUT, call, setup } from './uploads-kit.ts';

test('each limit reads as it is defined: binary ones in MiB, decimal ones in MB, small ones in bytes', () => {
  assert.equal(sizeLimitText(MAX_STORED_BYTES), '9.9 MB');
  assert.equal(sizeLimitText(PAYPAL_MAX_SEND_BYTES), '50 MB');
  assert.equal(sizeLimitText(MAX_FILE_BYTES), '5 MiB');
  assert.equal(sizeLimitText(PDF_MAX_BYTES), '10 MiB');
  assert.equal(sizeLimitText(MAX_STORAGE_BYTES), '300 MiB');
  assert.equal(sizeLimitText(400), '400 bytes');
  assert.equal(sizeLimitText(9_950_000), '9.95 MB');
});

test('the refusals name the limits that way: 5 MiB per image, 10 MiB per PDF, 9.9 MB per stored file', TIMEOUT, async () => {
  assert.equal(TOO_BIG, 'This PDF is larger than 10 MiB or has more than 30 pages. Prepare a smaller extract and upload it again.');
  const { app, people } = setup();
  const r = await call(app, P, { body: new Uint8Array(MAX_FILE_BYTES + 1), type: 'image/png', cookie: people.fullMember() });
  assert.equal(r.status, 413);
  assert.equal((r.body as unknown as { detail: string }).detail, 'Files up to 5 MiB');
  // The stored-file limit (9,900,000 bytes) as the rest of the product describes it, not «9.4 MB».
  const stored = setup({ storedFileBytes: 400 });
  const cookie = stored.people.fullMember();
  const text = await call(stored.app, P, { body: { text: `From: buyer\n${'The parcel arrived, thanks. '.repeat(40)}`, name: 'email.txt' }, cookie });
  const big = await call(stored.app, `${P}/${text.body.upload.id}/redact`, { body: { removals: [] }, cookie });
  assert.equal(big.status, 413);
  assert.match((big.body as unknown as { detail: string }).detail, /^Once cleaned, this text is larger than 400 bytes, the most a stored file can be/);
});
