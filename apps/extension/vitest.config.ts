import { defaultClientConditions } from 'vite';
import solid from 'vite-plugin-solid';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __TEST_SITE__: 'false',
  },
  // Resolve workspace packages to their TypeScript sources, so no build is needed.
  resolve: { conditions: ['answerwall-source', ...defaultClientConditions] },
  test: {
    name: 'extension',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
