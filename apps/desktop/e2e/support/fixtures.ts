/**
 * The test fixtures. Every test gets its own profile (user data, home, mock
 * log). An app a test starts is quit when the test ends, and the test fails
 * when any process of the app or any mock CLI is still running afterwards:
 * a suite that leaks processes is broken even when green.
 */
import { test as base, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_SERVER_OPTIONS, startServer, until } from '../../../../e2e/support/server.ts';
import type { AskTarget, TestServer } from '../../../../e2e/support/server.ts';
import { createProfile, launchDesktop, removeProfile, sweep } from './app.ts';
import type { DesktopApp, LaunchOptions, Profile } from './app.ts';

interface Fixtures {
  profile: Profile;
  /** Starts the app on this test's profile. Several starts in one test are restarts. */
  launch: (options?: LaunchOptions) => Promise<DesktopApp>;
  /** The app started in local mode (the choice already saved), and its window on the wall. */
  local: { app: DesktopApp; page: Page; origin: string };
  /** A real server for remote mode: compiled, on a loopback port, with mock CLIs. */
  server: TestServer;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  profile: async ({}, use) => {
    const profile = await createProfile();
    await use(profile);
    await removeProfile(profile);
  },

  launch: async ({ profile }, use, testInfo) => {
    const started: DesktopApp[] = [];
    await use(async (options) => {
      const app = await launchDesktop(profile, options);
      started.push(app);
      return app;
    });

    const last = started.at(-1);
    if (last && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('desktop-log', { body: await last.log(), contentType: 'text/plain' });
    }
    for (const app of started) {
      // A test may have quit or killed its app itself.
      await Promise.race([app.quit(), new Promise((resolve) => setTimeout(resolve, 30_000))]).catch(
        () => undefined,
      );
    }
    // The system may need a moment to reap what has just exited.
    await until(
      'the app to be gone',
      async () => (await last?.processes())?.length === 0 || last === undefined,
      10_000,
    ).catch(() => undefined);
    const left = await sweep(profile);
    if (testInfo.status === 'skipped') return;
    expect(left, 'processes that outlived the app').toEqual([]);
  },

  local: async ({ profile, launch }, use) => {
    await profile.seed({ mode: 'local' });
    const app = await launch();
    const page = await app.contentWindow();
    await expect(page.getByRole('form', { name: 'Ask' })).toBeVisible();
    await use({ app, page, origin: new URL(page.url()).origin });
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  server: async ({}, use) => {
    const server = await startServer(DEFAULT_SERVER_OPTIONS);
    let survivors: number[];
    try {
      await use(server);
    } finally {
      survivors = await server.stop();
    }
    expect(survivors, 'CLI processes that outlived the server shutdown').toEqual([]);
  },
});

export { expect, until };

/** A request to the local server made by the page itself, which is how the page is authorised. */
export async function pageApi<T = unknown>(
  page: Page,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ([verb, url, payload]) => {
      const response = await fetch(url, {
        method: verb,
        headers: {
          accept: 'application/json',
          ...(verb === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(verb === 'GET' ? {} : { body: payload }),
      });
      const text = await response.text();
      return { status: response.status, json: (text === '' ? undefined : JSON.parse(text)) as T };
    },
    [method, pathname, JSON.stringify(body ?? {})] as const,
  );
}

/** Stores a preset through the page and applies it with one click, as a user would. */
export async function arrange(page: Page, slots: AskTarget[], name = 'Test wall'): Promise<void> {
  const saved = await pageApi(page, 'PUT', '/api/presets/p-test', { name, slots });
  expect(saved.status, 'saving the preset').toBe(200);
  await page.reload();
  await page
    .getByRole('region', { name: 'Presets' })
    .getByRole('button', { name, exact: true })
    .click();
  await expect(page.locator('article.wall-cell')).toHaveCount(slots.length);
}

/**
 * Brings a cell on screen and returns it. A narrow window shows one cell at
 * a time and renders an answer only while its cell is shown; there the
 * cell's tab is chosen first. (A window without a display can be narrow.)
 */
export async function showCell(page: Page, slotId: string): Promise<Locator> {
  const tab = page.locator(`[id="wall-tab-${slotId}"]`);
  if ((await tab.count()) > 0) await tab.click();
  const cell = page.locator(`article.wall-cell[data-slot-id="${slotId}"]`);
  await expect(cell).toBeVisible();
  return cell;
}

export async function send(page: Page, text: string): Promise<void> {
  await page.locator('#wall-prompt').fill(text);
  await page.locator('form.wall-composer button[type="submit"]').click();
}
