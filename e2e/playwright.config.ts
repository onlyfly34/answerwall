import { defineConfig } from '@playwright/test';
import type { ReporterDescription } from '@playwright/test';

const CI = Boolean(process.env['CI']);
/**
 * The HTML report is written in CI and on request (`E2E_HTML_REPORT=1`). It
 * bundles the trace viewer's scripts, which a linter run over the repository
 * would otherwise pick up as source files.
 */
const HTML_REPORT = CI || Boolean(process.env['E2E_HTML_REPORT']);
const html: ReporterDescription = ['html', { open: 'never', outputFolder: 'playwright-report' }];
const github: ReporterDescription = ['github'];

/**
 * Three viewports of the same browser. A test tagged `@desktop`, `@tablet`
 * or `@phone` runs only there; everything else runs in all three.
 */
const only = (viewport: string): RegExp =>
  new RegExp(`@(?!${viewport}\\b)(desktop|tablet|phone)\\b`);

export default defineConfig({
  testDir: 'tests',
  outputDir: 'test-results',
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  ...(CI ? { workers: 4 } : {}),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ...(HTML_REPORT ? [html] : []), ...(CI ? [github] : [])],
  use: {
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'desktop',
      grepInvert: only('desktop'),
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      grepInvert: only('tablet'),
      use: { viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'phone',
      grepInvert: only('phone'),
      use: {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      },
    },
    {
      // Web cells: a Chromium with its own profile and an unpacked extension,
      // started by the tests' own fixtures (web-cells/support/fixtures.ts).
      name: 'web-cells',
      testDir: 'web-cells',
    },
  ],
});
