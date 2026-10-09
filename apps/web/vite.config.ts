import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin, ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { apiProxyDecision } from './src/proxyGuard';

// The ResolveKit server (apps/server) writes a per-launch token here. The proxy adds it to /api requests on the
// server side, so the browser never holds it and no other website can call the API.
const TOKEN_FILE = process.env.RESOLVEKIT_TOKEN_FILE ?? fileURLToPath(new URL('../server/.runtime-token', import.meta.url));
const API_TARGET = process.env.RESOLVEKIT_API ?? 'http://127.0.0.1:8787';

function readToken(): string | null {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Runs before Vite's proxy: only the app's own calls are forwarded and get the token (see proxyGuard.ts).
const guard: Connect.NextHandleFunction = (req, res, next) => {
  const d = apiProxyDecision(req.method ?? 'GET', req.headers);
  if (d.allow) return next();
  res.statusCode = d.status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: d.reason }));
};
const apiGuard: Plugin = {
  name: 'resolvekit-api-guard',
  configureServer: (server) => void server.middlewares.use('/api', guard),
  configurePreviewServer: (server) => void server.middlewares.use('/api', guard),
};

const api: Record<string, ProxyOptions> = {
  '/api': {
    target: API_TARGET,
    // Host becomes 127.0.0.1:8787, which the server requires (it refuses other Host headers: DNS rebinding).
    // changeOrigin only rewrites Host: the browser's Origin is forwarded untouched for the server's own checks.
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (req) => {
        const token = readToken();
        if (token) req.setHeader('x-resolvekit-token', token);
      });
    },
  },
};

export default defineConfig({
  plugins: [apiGuard, react()],
  server: { proxy: api },
  preview: { proxy: api },
  build: {
    // AG Grid Community (AllCommunityModule) is ~1 MB minified; keep it in its own cacheable chunk.
    chunkSizeWarningLimit: 1100,
    rollupOptions: { output: { manualChunks: { 'ag-grid': ['ag-grid-community', 'ag-grid-react'] } } },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
