import { defineProject } from 'vitest/config';

export default defineProject({
  // Resolve workspace packages to their TypeScript sources, so no build is needed.
  resolve: { conditions: ['answerwall-source'] },
  ssr: { resolve: { conditions: ['answerwall-source'] } },
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
