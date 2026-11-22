import type { Page, Response } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { cells, nav, prompt, sendButton } from '../support/wall.ts';

interface CacheListing {
  caches: string[];
  paths: string[];
}

/**
 * Waits until a service worker controls the page and has finished activating.
 * It claims the page from inside its `activate` event, so the page can be
 * controlled a moment before the worker's state says `activated`.
 */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
      });
    }
    const worker = registration.active;
    if (worker === null || worker.state === 'activated') return;
    await new Promise<void>((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') resolve();
      });
    });
  });
}

function cached(page: Page): Promise<CacheListing> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const paths: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
    }
    return { caches: names, paths: paths.sort() };
  });
}

test.describe('installable app', () => {
  test('the manifest and its icons are served', async ({ wallPage: page }) => {
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const response = await page.request.get(href ?? '');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      name: string;
      display: string;
      start_url: string;
      icons: { src: string; sizes: string }[];
    };
    expect(manifest.name).toBe('AnswerWall');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const image = await page.request.get(new URL(icon.src, new URL(href ?? '', page.url())).href);
      expect(image.status(), icon.src).toBe(200);
      expect(image.headers()['content-type']).toMatch(/^image\//);
    }
  });

  test('the service worker installs, serves the shell and never answers for the API', async ({
    wallPage: page,
    context,
    server,
    guard,
  }) => {
    guard.allowConsole(/net::ERR_/);
    await controlled(page);
    const registration = await page.evaluate(async () => {
      const current = await navigator.serviceWorker.getRegistration();
      return {
        scope: current?.scope,
        script: current?.active?.scriptURL,
        state: current?.active?.state,
      };
    });
    expect(registration).toEqual({
      scope: `${server.base}/`,
      script: `${server.base}/sw.js`,
      state: 'activated',
    });

    // What it stored at install time: the shell and the build's files, nothing of the API.
    const installed = await cached(page);
    expect(installed.caches).toHaveLength(1);
    expect(installed.caches[0]).toMatch(/^answerwall-static-[0-9a-f]{8}$/);
    expect(installed.paths).toContain('/index.html');
    expect(installed.paths.some((path) => /^\/assets\/.+\.js$/.test(path))).toBe(true);
    expect(installed.paths.filter((path) => path.startsWith('/api'))).toEqual([]);

    // A controlled page: the shell and its files come from the worker, every API answer from the network.
    const responses: Response[] = [];
    page.on('response', (response) => responses.push(response));
    await page.reload();
    await expect(cells(page)).toHaveCount(3);
    await prompt(page).fill('Through the worker');
    await sendButton(page).click();
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(3);
    await nav(page, 'History').click();
    await expect(page.locator('.wall-history-item')).toHaveCount(1);
    await nav(page, 'Providers').click();
    await nav(page, 'Settings').click();
    await expect(page.getByRole('region', { name: 'Devices' }).getByRole('listitem')).toHaveCount(
      1,
    );

    const pathOf = (response: Response): string => new URL(response.url()).pathname;
    const api = responses.filter((response) => pathOf(response).startsWith('/api/'));
    expect(api.length).toBeGreaterThan(8);
    expect(
      api.filter((response) => response.fromServiceWorker()).map(pathOf),
      'API responses answered by the service worker',
    ).toEqual([]);
    expect(api.some((response) => pathOf(response).endsWith('/stream'))).toBe(true);
    const shell = responses.find((response) => response.request().isNavigationRequest());
    expect(shell?.fromServiceWorker()).toBe(true);
    const scripts = responses.filter((response) => /^\/assets\/.+\.js$/.test(pathOf(response)));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((response) => response.fromServiceWorker())).toBe(true);

    // API data is always live: a change made elsewhere is there on the next request.
    const names = (): Promise<string[]> =>
      page.evaluate(async () => {
        const response = await fetch('/api/presets');
        const body = (await response.json()) as { presets: { name: string }[] };
        return body.presets.map((preset) => preset.name);
      });
    expect(await names()).toEqual([]);
    await server.putPreset('p-live', {
      name: 'Live',
      slots: [{ slotId: 'a', providerId: 'claude' }],
    });
    expect(await names()).toEqual(['Live']);
    await server.api('DELETE', '/api/presets/p-live');
    expect(await names()).toEqual([]);

    // Nothing was added to the cache while the app was used.
    expect(await cached(page)).toEqual(installed);

    // Without a network the shell still opens, from the cache, and says the server is out of reach:
    // no answer of the API was kept to pretend otherwise.
    await context.setOffline(true);
    await page.goto('/history');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AnswerWall');
    await expect(page.getByRole('alert')).toHaveText('The server cannot be reached.');
    await expect(page.locator('.wall-history-item')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);

    // When the network returns, the app loads by itself and is still signed in.
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await expect(page.locator('.wall-history-item')).toHaveCount(1);
  });

  test('a page from an older build updates itself once, then asks', async ({
    page,
    signIn,
    guard,
  }) => {
    guard.allowConsole(/status of 401/);
    await signIn();
    // The server answers as a newer version than the page was built for.
    await page.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      const meta = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...meta, version: '999.0.0' } });
    });
    let loads = 0;
    page.on('load', () => (loads += 1));

    await page.goto('/');
    // One reload on its own, to pick up the new build; then it stops and lets the user decide.
    await expect(page.locator('.app-status [role="status"]')).toHaveText(
      'The server now runs version 999.0.0. Updating this page…',
    );
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect.poll(() => loads).toBe(2);
    await page.waitForTimeout(500);
    expect(loads).toBe(2);
    await expect(page.getByRole('form', { name: 'Ask' })).toHaveCount(0);

    // Once page and server agree again, the app opens.
    await page.unroute('**/api/meta');
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByRole('form', { name: 'Ask' })).toBeVisible();
  });
});
