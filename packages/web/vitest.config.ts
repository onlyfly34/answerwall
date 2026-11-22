import { defineProject, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      // Style sheets are empty in tests, except the tokens, which a test reads.
      css: { include: [/contracts\/theme\.css/] },
    },
  }),
);
