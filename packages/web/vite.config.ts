import { defaultClientConditions, defineConfig } from 'vite';
import type { Plugin } from 'vite';
import solid from 'vite-plugin-solid';
// Imported by path: this file runs in Node before any package is built.
import { BRAND } from '../core/src/brand.ts';

const apiTarget = `http://127.0.0.1:${process.env[`${BRAND.envPrefix}PORT`] ?? BRAND.defaultPort}`;

const brandHtml: Plugin = {
  name: 'brand-html',
  transformIndexHtml: (html) => html.replaceAll('%BRAND_NAME%', BRAND.name),
};

export default defineConfig({
  plugins: [solid(), brandHtml],
  resolve: {
    // Resolve @answerwall/core/protocol to its TypeScript source.
    conditions: ['answerwall-source', ...defaultClientConditions],
  },
  server: {
    proxy: {
      // The core server checks Host and Origin, so the proxy presents its origin.
      '/api': { target: apiTarget, changeOrigin: true, headers: { Origin: apiTarget } },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
