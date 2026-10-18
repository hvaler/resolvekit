import type { IncomingMessage, ServerResponse } from 'node:http';
import { PEER_HEADER, clientIp, type ProxyTrust } from '@resolvekit/hosting';
import type { Handler } from './app.ts';
import { CASE_FILES } from './documents.ts';
import { MAX_FILE_BYTES, PDF_MAX_BYTES } from './uploads/limits.ts';
import { UPLOAD_PATH, isImageType, isPdfType } from './uploads/routes.ts';

const MAX_BODY = 256 * 1024;
/** Bodies over {@link MAX_BODY} being read at once (each up to PDF_MAX_BYTES in memory). */
const MAX_LARGE_IN_FLIGHT = 3;
/** A large body must arrive whole within this time, or its connection is dropped (slow clients cannot hold a slot). */
export const LARGE_BODY_DEADLINE_MS = 30_000;
/** After a refusal, how long the rest of the body is dropped (so the client reads the answer, not a reset). */
const DRAIN_MS = 1_000;

/**
 * The body limit of a request: posted to the upload route of a case that exists, MAX_FILE_BYTES for an image
 * (image/png, image/jpeg) and PDF_MAX_BYTES for a PDF (application/pdf); 256 KB for everything else. Decided on the
 * request line and headers alone, before reading.
 */
export function bodyLimit(method: string, path: string, contentType: string | null | undefined): number {
  const caseId = UPLOAD_PATH.exec(path)?.[1];
  if (method !== 'POST' || !caseId || !Object.hasOwn(CASE_FILES, caseId)) return MAX_BODY;
  return isImageType(contentType ?? null) ? MAX_FILE_BYTES : isPdfType(contentType ?? null) ? PDF_MAX_BYTES : MAX_BODY;
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

export interface NodeListenerOptions {
  /** Hosted: how the client address is derived (as in hosted.ts). Default: the socket's peer address only. */
  trustedHops?: number;
  proxyTrust?: ProxyTrust;
  /** A large body must have arrived completely within this time (default {@link LARGE_BODY_DEADLINE_MS}). */
  largeBodyDeadlineMs?: number;
  /** One line per failed request: the error's name only. */
  log?: (line: string) => void;
}

/** The client's address key, derived as hosted mode does (clientIp), from the peer and X-Forwarded-For only. */
function clientKey(req: IncomingMessage, o: NodeListenerOptions): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const xff = req.headers['x-forwarded-for'];
  try {
    const h = new Headers({ [PEER_HEADER]: peer });
    if (typeof xff === 'string') h.set('x-forwarded-for', xff);
    return clientIp(new Request('http://client.invalid/', { headers: h }), o.trustedHops ?? 1, o.proxyTrust ?? 'none');
  } catch {
    return peer;
  }
}

const sendJson = (res: ServerResponse, status: number, error: string) => {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ error });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
};

/**
 * Adapt a Web `Request → Response` handler to node:http (one listener per process). Bodies over the request's limit
 * ({@link bodyLimit}) are refused with 413: on the declared Content-Length before anything is read, or as soon as the
 * limit is passed. A body over 256 KB (or of unknown length) needs a large-body slot: at most
 * {@link MAX_LARGE_IN_FLIGHT} in the process and one per client address, else 503 BUSY before reading; it must arrive
 * whole within the deadline, else the connection is dropped. A request that cannot be built is answered 400, a failing
 * handler 500, without details; the response is always ended.
 */
export function toNodeListener(handler: Handler, origin: string, o: NodeListenerOptions = {}) {
  const deadlineMs = o.largeBodyDeadlineMs ?? LARGE_BODY_DEADLINE_MS;
  let large = 0;
  const perClient = new Map<string, number>();

  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const limit = bodyLimit(method, (req.url ?? '/').split('?')[0]!, req.headers['content-type']);
    const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return refuseUnread(req, res, 413, 'BODY_TOO_LARGE');
    let release = () => {};
    let timer: NodeJS.Timeout | undefined;
    if (limit > MAX_BODY && !(declared <= MAX_BODY)) {
      const key = clientKey(req, o);
      if (large >= MAX_LARGE_IN_FLIGHT || perClient.has(key)) return refuseUnread(req, res, 503, 'BUSY');
      large++;
      perClient.set(key, 1);
      // Too slow a body (slowloris) loses its connection, and so its slot.
      timer = setTimeout(() => req.socket.destroy(), deadlineMs);
      timer.unref();
      let held = true;
      release = () => {
        clearTimeout(timer);
        if (!held) return;
        held = false;
        large--;
        perClient.delete(key);
      };
      // Held until the answer is sent (the body stays in memory until then).
      res.once('close', release);
    }
    // A client that goes away mid-body (or is dropped) gets no answer.
    const body = await readBody(req, limit).catch(() => undefined);
    // The body is in (or refused): the deadline no longer applies.
    clearTimeout(timer);
    if (body === undefined) {
      release();
      return void res.destroy();
    }
    if (body === null) {
      release();
      return refuseUnread(req, res, 413, 'BODY_TOO_LARGE');
    }

    let request: Request;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      // The TCP peer, for hosted mode's client IP when no proxy is in front; a client-sent copy never survives.
      headers.set(PEER_HEADER, req.socket.remoteAddress ?? 'unknown');
      request = new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      });
    } catch (e) {
      o.log?.(`node · request refused (400) · ${(e as Error)?.name ?? 'Error'}`);
      return sendJson(res, 400, 'BAD_REQUEST');
    }
    let response: Response;
    let bytes: Buffer;
    try {
      response = await handler(request);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (e) {
      o.log?.(`node · handler failed (500) · ${(e as Error)?.name ?? 'Error'}`);
      return sendJson(res, 500, 'INTERNAL');
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(bytes);
  };

  return (req: IncomingMessage, res: ServerResponse) => {
    serve(req, res).catch((e) => {
      o.log?.(`node · request failed · ${(e as Error)?.name ?? 'Error'}`);
      try {
        sendJson(res, 500, 'INTERNAL');
      } catch {
        res.destroy();
      }
    });
  };
}
