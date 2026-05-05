import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';
import pkg from './package.json';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext'
  },
  esbuild: {
    // Strip chatty/dev-time logging in production but keep warn/error —
    // those communicate real failures a user might surface to us. The
    // original `drop: ['console']` stripped EVERY console method, which
    // also silenced `console.warn` / `console.error`, making prod
    // failures invisible to anyone reading DevTools.
    pure: mode === 'production'
      ? ['console.log', 'console.debug', 'console.info', 'console.trace']
      : [],
    drop: mode === 'production' ? ['debugger'] : []
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  define: {
    VITE_APP_VERSION: JSON.stringify(pkg.version)
  }
}));
