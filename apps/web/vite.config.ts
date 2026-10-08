import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
