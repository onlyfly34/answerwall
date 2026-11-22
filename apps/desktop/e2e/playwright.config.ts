import { defineConfig } from '@playwright/test';
import type { ReporterDescription } from '@playwright/test';

const CI = Boolean(process.env['CI']);
const html: ReporterDescription = ['html', { open: 'never', outputFolder: 'playwright-report' }];
const github: ReporterDescription = ['github'];

/**
 * The desktop app, driven through Playwright's Electron support. Each test
 * starts its own app with its own user data directory. One app at a time:
 * the tests count processes, and several apps starting at once on a small
 * runner make every timing in them meaningless.
 */
export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results',
  globalSetup: './support/global-setup.ts',
  // The same proof as for the server suite: nothing registered is still running.
  globalTeardown: '../../../e2e/support/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ...(CI ? [html, github] : [])],
});
