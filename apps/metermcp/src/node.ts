import type { IncomingMessage, ServerResponse } from 'node:http';
import { PEER_HEADER } from '@resolvekit/hosting';

const MAX_BODY = 256 * 1024;

export interface NodeListenerOptions {
  /** One line per failed request: the error's name only. */
  log?: (line: string) => void;
}

const sendJson = (res: ServerResponse, status: number, error: string) => {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ error });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
};

/**
 * Adapt a Web `Request → Response` handler to node:http. Bodies over 256 KB are refused. The response body is
 * streamed (an MCP GET stream stays open), and cancelled when the client goes away. No request can take the process
 * down: a client that goes away mid-body gets no answer, a request that cannot be built (a method Fetch refuses, such
 * as TRACE) is answered 400, a failing handler 500, without details; once headers are sent a failure only drops the
 * connection.
 */
export function toNodeListener(handler: (req: Request) => Promise<Response>, origin: string, o: NodeListenerOptions = {}) {
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"BODY_TOO_LARGE"}');
          return;
        }
        chunks.push(c as Buffer);
      }
    } catch {
      // The client went away mid-body (or was dropped): nobody to answer.
      return void res.destroy();
    }
    const method = req.method ?? 'GET';
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let request: Request;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      // The TCP peer, for hosted mode's client IP when no proxy is in front; a client-sent copy never survives.
      headers.set(PEER_HEADER, req.socket.remoteAddress ?? 'unknown');
      request = new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
        signal: abort.signal,
      });
    } catch (e) {
      o.log?.(`node · request refused (400) · ${(e as Error)?.name ?? 'Error'}`);
      return sendJson(res, 400, 'BAD_REQUEST');
    }
    let response: Response;
    try {
      response = await handler(request);
    } catch (e) {
      o.log?.(`node · handler failed (500) · ${(e as Error)?.name ?? 'Error'}`);
      return sendJson(res, 500, 'INTERNAL');
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return void res.end();
    const reader = response.body.getReader();
    res.on('close', () => void reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // client gone
    }
    res.end();
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
