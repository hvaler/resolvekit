import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient } from '@resolvekit/paypal';
import { createApi, type ActingPerson } from '../src/app.ts';
import { canDeleteUpload, canEditUpload } from '../src/uploads/permissions.ts';
import type { UploadRecord } from '../src/uploads/store.ts';

const person = (o: Partial<ActingPerson>): ActingPerson => ({ id: 'p1', name: 'Ana', label: 'Ana (member)', workspaceId: 'ws1', role: 'member', reviewer: false, ...o });
const upload = (by: string) => ({ uploadedBy: { id: by, label: 'x', name: 'x' } }) as UploadRecord;

test('permissions: an owner edits and deletes any upload', () => {
  const owner = person({ role: 'owner' });
  assert.equal(canEditUpload(owner, upload('someone-else')), true);
  assert.equal(canDeleteUpload(owner), true);
});

test('permissions: a full member edits and deletes any upload', () => {
  const member = person({ role: 'member', reviewer: false });
  assert.equal(canEditUpload(member, upload('someone-else')), true);
  assert.equal(canDeleteUpload(member), true);
});

test('permissions: a reviewer edits only their own upload and never deletes', () => {
  const reviewer = person({ role: 'member', reviewer: true });
  assert.equal(canEditUpload(reviewer, upload('p1')), true);
  assert.equal(canEditUpload(reviewer, upload('someone-else')), false);
  assert.equal(canDeleteUpload(reviewer), false);
});

test('local mode (no gate): the acting person is the local operator, an owner and not a reviewer', () => {
  const fetch = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
  const api = createApi({ paypal: new PayPalClient({ clientId: 'cid', clientSecret: 'secret', env: 'sandbox', fetch }), env: 'sandbox', bindings: {}, analyst: null });
  assert.deepEqual(api.personOf(new Request('http://localhost/api/x')), { id: 'local', name: 'local operator', label: 'local operator', workspaceId: 'local', role: 'owner', reviewer: false });
});
