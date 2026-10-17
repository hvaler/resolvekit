import test from 'node:test';
import assert from 'node:assert/strict';
import { pastedTextPdf, redactText, textLines } from '../src/uploads/text.ts';
import { UploadError } from '../src/uploads/image.ts';
import { MAX_TEXT_CHARS } from '../src/uploads/limits.ts';

test('removed spans become [redacted] and their text is gone', () => {
  const t = 'call Maria Lopez at 600123456 now';
  assert.equal(redactText(t, [{ start: 5, end: 16 }, { start: 20, end: 29 }]), 'call [redacted] at [redacted] now');
  assert.equal(redactText(t, [{ start: 5, end: 12 }, { start: 10, end: 16 }]), 'call [redacted] at 600123456 now');
  assert.equal(redactText(t, [{ start: 30, end: t.length }]), 'call Maria Lopez at 600123456 [redacted]');
  assert.equal(redactText(t, []), t);
  assert.throws(() => redactText(t, [{ start: 0, end: t.length + 1 }]), (e) => e instanceof UploadError && e.code === 'BAD_REDACTION' && e.status === 422);
  assert.throws(() => redactText(t, [{ start: 5, end: 5 }]), (e) => e instanceof UploadError && e.code === 'BAD_REDACTION');
});

test('textLines splits, trims, drops trailing empties and wraps long lines at a space', () => {
  assert.deepEqual(textLines('a  \r\nb\n\n\n'), ['a', 'b']);
  const long = Array(100).fill('word').join(' ');
  const lines = textLines(long);
  assert.ok(lines.length > 1 && lines.every((l) => l.length <= 300));
  assert.equal(lines.join(' '), long);
});

test('the PDF holds the redacted text and not the removed text', () => {
  const t = 'Customer Maria Lopez said the parcel never came';
  const start = t.indexOf('Maria Lopez');
  const out = pastedTextPdf({ title: 'Message', by: 'shop@example.com', lines: textLines(redactText(t, [{ start, end: start + 11 }])) });
  const s = Buffer.from(out.pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF'));
  assert.ok(!s.includes('Maria Lopez'));
  assert.ok(s.includes('[redacted]'));
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
});

test('more than 20,000 characters is refused', () => {
  const big = 'x'.repeat(MAX_TEXT_CHARS + 1);
  assert.throws(() => textLines(big), (e) => e instanceof UploadError && e.code === 'TOO_LONG' && e.status === 413);
  assert.throws(() => redactText(big, []), (e) => e instanceof UploadError && e.code === 'TOO_LONG');
  assert.doesNotThrow(() => textLines('x'.repeat(MAX_TEXT_CHARS)));
});
