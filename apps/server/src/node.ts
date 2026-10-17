import type { IncomingMessage, ServerResponse } from 'node:http';
import { PEER_HEADER } from '@resolvekit/hosting';
import type { Handler } from './app.ts';
import { CASE_FILES } from './documents.ts';
import { MAX_FILE_BYTES } from './uploads/limits.ts';
import { UPLOAD_PATH, isImageType } from './uploads/routes.ts';

const MAX_BODY = 256 * 1024;
/** Bodies over {@link MAX_BODY} being read at once (each up to MAX_FILE_BYTES in memory). */
const MAX_LARGE_IN_FLIGHT = 3;
/** After a refusal, how long the rest of the body is dropped (so the client reads the answer, not a reset). */
const DRAIN_MS = 1_000;

/**
 * The body limit of a request: MAX_FILE_BYTES for an image (image/png, image/jpeg) posted to the upload route of a
 * case that exists, 256 KB for everything else. Decided on the request line and headers alone, before reading.
 */
export function bodyLimit(method: string, path: string, contentType: string | null | undefined): number {
  const caseId = UPLOAD_PATH.exec(path)?.[1];
  return method === 'POST' && caseId && Object.hasOwn(CASE_FILES, caseId) && isImageType(contentType ?? null) ? MAX_FILE_BYTES : MAX_BODY;
}

/** The whole body, or null as soon as it passes `limit` (nothing more is kept). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.off('data', onData);
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

/**
 * Answer without reading the body, and close the connection. The answer is written whole (with its length) at once;
 * the rest of the body is dropped, never kept, until the client stops or {@link DRAIN_MS} pass, then the socket closes.
 */
function refuseUnread(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
  const body = JSON.stringify({ error });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  res.write(body);
  const timer = setTimeout(() => {
    res.end();
    req.socket.destroy();
  }, DRAIN_MS);
  timer.unref();
  req.once('end', () => {
    clearTimeout(timer);
    res.end();
  });
  req.resume();
}

/**
 * Adapt a Web `Request → Response` handler to node:http (one listener per process). Bodies over the request's limit
 * ({@link bodyLimit}) are refused with 413: on the declared Content-Length before anything is read, or as soon as the
 * limit is passed. At most {@link MAX_LARGE_IN_FLIGHT} bodies over 256 KB (or of unknown length) are read at once;
 * beyond that, 503 BUSY before reading.
 */
export function toNodeListener(handler: Handler, origin: string) {
  let large = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const limit = bodyLimit(method, (req.url ?? '/').split('?')[0]!, req.headers['content-type']);
    const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return refuseUnread(req, res, 413, 'BODY_TOO_LARGE');
    if (limit > MAX_BODY && !(declared <= MAX_BODY)) {
      if (large >= MAX_LARGE_IN_FLIGHT) return refuseUnread(req, res, 503, 'BUSY');
      large++;
      res.once('close', () => large--);
    }
    // A client that goes away mid-body gets no answer (and frees its slot).
    const body = await readBody(req, limit).catch(() => undefined);
    if (body === undefined) return void res.destroy();
    if (body === null) return refuseUnread(req, res, 413, 'BODY_TOO_LARGE');
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
