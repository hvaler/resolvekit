/**
 * Decides whether the Vite dev/preview server may forward a browser request to the ResolveKit API (and attach the
 * per-launch token). Without this the dev server would be a confused deputy: any website could send a request to
 * localhost:5173/api/... and get the token added. Pure (headers in, decision out) so it is tested directly.
 */
export type ProxyDecision = { allow: true } | { allow: false; status: number; reason: string };

type Headers = Readonly<Record<string, string | string[] | undefined>>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function apiProxyDecision(method: string, headers: Headers): ProxyDecision {
  // Host must be this machine (blocks DNS rebinding against the dev server itself).
  const host = one(headers.host) ?? '';
  const m = /^([^:]+)(?::(\d+))?$/.exec(host);
  if (!m || !LOCAL_HOSTS.has(m[1]!)) return { allow: false, status: 403, reason: 'FORBIDDEN_HOST' };
  const port = m[2] ? `:${m[2]}` : '';

  const site = one(headers['sec-fetch-site']);
  if (site === 'cross-site' || site === 'same-site') return { allow: false, status: 403, reason: 'CROSS_SITE' };

  // The app's own pages are served from this same origin; anything else is another site.
  const origin = one(headers.origin);
  if (origin != null && origin !== `http://localhost${port}` && origin !== `http://127.0.0.1${port}`) {
    return { allow: false, status: 403, reason: 'FORBIDDEN_ORIGIN' };
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    if (!/^application\/json\s*(;|$)/i.test(one(headers['content-type']) ?? '')) return { allow: false, status: 415, reason: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  return { allow: true };
}
