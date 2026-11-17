import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, /api is forwarded to a controller reachable on localhost,
// e.g. `kubectl -n platform port-forward svc/controller 8081:80`.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8081',
    },
  },
});
