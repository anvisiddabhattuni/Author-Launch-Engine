import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The same policy the API and nginx send (STORY-031). Imported, not copied: a
// policy written three times is three policies.
import { uiHeaders } from '../server/src/services/securityHeaders.js';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Report-only in dev: React fast-refresh injects an inline script, and a
    // dev server that blocks its own hot reload gets its policy deleted. The
    // violations still print in the console.
    headers: uiHeaders({ enforce: false }),
    // Keeps the browser on one origin so no CORS handling is needed in dev.
    proxy: {
      // A regex, not a prefix: '/api' also matched the UI's own /api-keys page
      // (STORY-045) and sent it to the API, which answered 404.
      '^/api(/|$)': 'http://localhost:4000',
    },
  },
  // `vite preview` serves the production build, and enforces — this is what
  // the browser check drives, because it is what users would get.
  preview: {
    port: 4173,
    headers: uiHeaders({ enforce: true }),
    proxy: {
      // A regex, not a prefix: '/api' also matched the UI's own /api-keys page
      // (STORY-045) and sent it to the API, which answered 404.
      '^/api(/|$)': 'http://localhost:4000',
    },
  },
});
