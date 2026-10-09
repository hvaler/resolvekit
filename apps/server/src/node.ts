import type { IncomingMessage, ServerResponse } from 'node:http';
import { PEER_HEADER } from '@resolvekit/hosting';
import type { Handler } from './app.ts';

const MAX_BODY = 256 * 1024;

/** Adapt a Web `Request → Response` handler to node:http. Bodies over 256 KB are refused. */
export function toNodeListener(handler: Handler, origin: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"BODY_TOO_LARGE"}');
        return;
      }
      chunks.push(c as Buffer);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    // The TCP peer, for hosted mode's client IP when no proxy is in front; a client-sent copy never survives.
    headers.set(PEER_HEADER, req.socket.remoteAddress ?? 'unknown');
    const method = req.method ?? 'GET';
    const request = new Request(new URL(req.url ?? '/', origin), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
