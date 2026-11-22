import { readFileSync } from 'node:fs';
import { defaultClientConditions, defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import solid from 'vite-plugin-solid';
// Imported by path: this file runs in Node before any package is built.
import { BRAND } from '../core/src/brand.ts';

const apiTarget = `http://127.0.0.1:${process.env[`${BRAND.envPrefix}PORT`] ?? BRAND.defaultPort}`;

// The server reports the version of its own manifest; the bundle carries the
// same one so the shell can tell when the two no longer match.
const serverManifest = JSON.parse(
  readFileSync(new URL('../../apps/server/package.json', import.meta.url), 'utf8'),
) as { version: string };

const THEME_COLOR = '#2f6feb';

const brandHtml: Plugin = {
  name: 'brand-html',
  transformIndexHtml: (html) =>
    html.replaceAll('%BRAND_NAME%', BRAND.name).replaceAll('%THEME_COLOR%', THEME_COLOR),
};

// The service worker is built from src/pwa/sw.ts; the plugin only compiles it
// and hands it the list of build files. Registration is done by the app
// (src/pwa/updater.ts) because the page allows no inline script.
const pwa = VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src/pwa',
  filename: 'sw.ts',
  injectRegister: false,
  // The glob below already lists everything in public/, the icons included.
  includeManifestIcons: false,
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
  },
  manifest: {
    id: '/',
    name: BRAND.name,
    short_name: BRAND.name,
    description: 'One prompt in, many answers side by side.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: THEME_COLOR,
    background_color: '#14171b',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  },
});

export default defineConfig({
  // Tests need neither the worker nor the manifest.
  plugins: [solid(), brandHtml, ...(process.env.VITEST ? [] : [pwa])],
  define: {
    __APP_VERSION__: JSON.stringify(serverManifest.version),
  },
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
