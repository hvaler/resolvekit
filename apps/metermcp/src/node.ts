import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 256 * 1024;

/**
 * Adapt a Web `Request → Response` handler to node:http. Bodies over 256 KB are refused. The response body is
 * streamed (an MCP GET stream stays open), and cancelled when the client goes away.
 */
export function toNodeListener(handler: (req: Request) => Promise<Response>, origin: string) {
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
    const method = req.method ?? 'GET';
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const request = new Request(new URL(req.url ?? '/', origin), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
      signal: abort.signal,
    });
    const response = await handler(request);
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
}
