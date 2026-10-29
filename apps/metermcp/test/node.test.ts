import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { toNodeListener } from '../src/node.ts';

/** A real http server on an ephemeral port, with the listener under test. */
async function listen(handler: (req: Request) => Promise<Response>) {
  const lines: string[] = [];
  const server: Server = createServer(toNodeListener(handler, 'http://127.0.0.1', { log: (l) => lines.push(l) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const send = (method: string, path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on('error', reject);
      r.end();
    });
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { port, lines, send, close };
}

const ok = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });

test('a method a Fetch Request cannot carry (TRACE) is answered 400 BAD_REQUEST, and the process keeps serving', async () => {
  const l = await listen(ok);
  try {
    const traced = await l.send('TRACE', '/health');
    assert.equal(traced.status, 400);
    assert.match(traced.body, /BAD_REQUEST/);
    assert.equal((await l.send('GET', '/health')).status, 200);
  } finally {
    await l.close();
  }
});

test('a client that goes away mid-body gets no answer, and the process keeps serving', async () => {
  let reached = 0;
  const l = await listen(async () => {
    reached++;
    return ok();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const s = connect(l.port, '127.0.0.1', () => {
        s.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"partial":');
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 50);
      });
      s.on('error', reject);
    });
    // Let the server see the reset.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(reached, 0);
    assert.equal((await l.send('GET', '/health')).status, 200);
    assert.equal(reached, 1);
  } finally {
    await l.close();
  }
});

test('a failing handler is answered 500 INTERNAL without its details, and the process keeps serving', async () => {
  let fail = true;
  const l = await listen(async () => {
    if (fail) throw new Error('secret detail 9988776655');
    return ok();
  });
  try {
    const broken = await l.send('GET', '/health');
    assert.equal(broken.status, 500);
    assert.match(broken.body, /INTERNAL/);
    assert.ok(!broken.body.includes('secret'), broken.body);
    assert.ok(l.lines.length >= 1 && l.lines.every((x) => !x.includes('secret')), JSON.stringify(l.lines));
    fail = false;
    assert.equal((await l.send('GET', '/health')).status, 200);
  } finally {
    await l.close();
  }
});
