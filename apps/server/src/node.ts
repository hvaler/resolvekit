import type { IncomingMessage, ServerResponse } from 'node:http';
import { PEER_HEADER } from '@resolvekit/hosting';
import type { Handler } from './app.ts';
import { MAX_FILE_BYTES } from './uploads/limits.ts';
import { UPLOAD_PATH } from './uploads/routes.ts';

const MAX_BODY = 256 * 1024;

/** The body limit of a request: an evidence file on the upload route, 256 KB anywhere else. */
export function bodyLimit(method: string, path: string): number {
  return method === 'POST' && UPLOAD_PATH.test(path) ? MAX_FILE_BYTES : MAX_BODY;
}

/** The whole body, or null as soon as it passes `limit` (nothing more is read). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** After a 413, how long the rest of the body is dropped (so the client reads the answer, not a reset) before closing. */
const DRAIN_MS = 1_000;

/**
 * Adapt a Web `Request → Response` handler to node:http. Bodies over the path's limit ({@link bodyLimit}) are refused
 * with 413: on the declared Content-Length before anything is read, or as soon as the limit is passed. Nothing more
 * is kept: the rest is dropped for {@link DRAIN_MS} at most, then the connection is closed.
 */
export function toNodeListener(handler: Handler, origin: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const limit = bodyLimit(method, (req.url ?? '/').split('?')[0]!);
    const tooLarge = () => {
      res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"BODY_TOO_LARGE"}');
      req.resume();
      setTimeout(() => {
        if (!req.complete) req.socket.destroy();
      }, DRAIN_MS).unref();
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return tooLarge();
    const body = await readBody(req, limit);
    if (body === null) return tooLarge();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    // The TCP peer, for hosted mode's client IP when no proxy is in front; a client-sent copy never survives.
    headers.set(PEER_HEADER, req.socket.remoteAddress ?? 'unknown');
    const request = new Request(new URL(req.url ?? '/', origin), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
