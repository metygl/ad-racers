import { defineConfig } from 'vite';

// The site is published at https://<user>.github.io/ad-racers/, so production
// builds need that sub-path baked in. Dev/preview stay at the server root.
// BASE_PATH lets CI (or a fork under a different repo name) override it.
const base = process.env.BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/ad-racers/' : '/');

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    // Hashed filenames everywhere so the CDN can cache aggressively and a new
    // deploy can never serve a stale mix of old and new chunks.
    assetsInlineLimit: 2048,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
    // three.js is ~600 kB minified on its own; the budget check in
    // scripts/check-budget.mjs is the real gate, this only silences noise.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
