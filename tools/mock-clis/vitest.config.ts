import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mock-clis',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
