/**
 * Fixtures of the extension tests: a real Chromium with its own profile and
 * the test build of `apps/extension` loaded unpacked, the stand-in vendor
 * site, a compiled AnswerWall server with the mock CLIs, and a plain web
 * page on a third origin. No real site is ever contacted: the test build
 * shows the stand-in in place of the one site these tests configure.
 */
import { chromium } from '@playwright/test';
import type { Frame, FrameLocator, Page, Worker } from '@playwright/test';
import { extensionDir } from '../../support/environment.ts';
import { expect, test as base } from '../../web-cells/support/fixtures.ts';

/** The provider the test build points at the stand-in site. */
export const WEB_PROVIDER = {
  id: 'web-claude',
  kind: 'web',
  site: 'claude',
  label: 'Stand-in site',
  enabled: true,
  concurrency: 2,
  models: [],
} as const;

export interface Switches {
  fillPrompt: boolean;
  readAnswer: boolean;
}

interface StoredProviders {
  settings: { providers: { id: string; [key: string]: unknown }[] };
}

interface Fixtures {
  /** The extension's service worker. */
  worker: Worker;
  /** Tells the test build where the stand-in site is, and which of its pages a cell opens. */
  useStandIn: (path?: string) => Promise<void>;
  /** On the server: web cells on, this extension listed, the stand-in's provider added. */
  allowExtension: (switches: Switches) => Promise<void>;
  /** Opens the extension's wall page in a new tab. */
  openWallPage: () => Promise<Page>;
  /** Fills in the first-run page and waits for the wall. */
  connect: (wall: Page) => Promise<void>;
  /** The header rules the extension has installed right now. */
  sessionRules: () => Promise<{ id: number; condition: Record<string, unknown> }[]>;
}

export const test = base.extend<Fixtures>({
  context: async ({ blockThirdPartyCookies: _unused }, use, testInfo) => {
    const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      // The bundled Chromium loads extensions in its headless mode; the
      // headless shell does not.
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionDir()}`, `--load-extension=${extensionDir()}`],
    });
    await use(context);
    await context.close();
  },

  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },

  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },

  useStandIn: async ({ worker, vendor }, use) => {
    await use(async (path = '/') => {
      await worker.evaluate(
        ([origin, start]) =>
          chrome.storage.local.set({ testSiteOrigin: origin, testSitePath: start }),
        [vendor.origin, path] as const,
      );
    });
  },

  allowExtension: async ({ server, extensionId }, use) => {
    await use(async (switches) => {
      const current = await server.api<StoredProviders>('GET', '/api/settings');
      const providers = current.json.settings.providers.filter(
        (provider) => provider.id !== WEB_PROVIDER.id,
      );
      const saved = await server.api('PUT', '/api/settings', {
        webCells: { enabled: true, ...switches, extensionIds: [extensionId] },
        providers: [...providers, WEB_PROVIDER],
      });
      expect(saved.status).toBe(200);
    });
  },

  openWallPage: async ({ context, extensionId }, use) => {
    await use(async () => {
      const wall = await context.newPage();
      await wall.goto(`chrome-extension://${extensionId}/wall.html`);
      return wall;
    });
  },

  connect: async ({ server }, use) => {
    await use(async (wall) => {
      await wall.getByLabel('Server address').fill(server.base);
      await wall.getByLabel('Pairing code').fill(await server.mintPairingCode());
      await wall.getByRole('button', { name: 'Connect' }).click();
      await expect(wall.getByRole('form', { name: 'Ask' })).toBeVisible();
    });
  },

  sessionRules: async ({ worker }, use) => {
    await use(() => worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()));
  },
});

export { expect };

/** The page a web cell frames. */
export const framed = (wall: Page, slotId: string): FrameLocator =>
  wall.frameLocator(`article.wall-cell[data-slot-id="${slotId}"] iframe.wall-web-frame`);

/** The frame of a web cell, once it has finished (or failed) loading. */
export async function frameOf(page: Page, selector: string): Promise<Frame> {
  const handle = await page.locator(selector).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`${selector} has no frame`);
  await frame.waitForLoadState('load').catch(() => undefined);
  return frame;
}

/** Whether a frame shows the browser's refusal instead of the page it was sent to. */
export async function refused(page: Page, selector: string): Promise<boolean> {
  return (await frameOf(page, selector)).url().startsWith('chrome-error://');
}

/** What the cell says about its connection to the page it frames. */
export const connectionOf = (wall: Page, slotId: string) =>
  wall.locator(`article.wall-cell[data-slot-id="${slotId}"]`).getByTestId('web-connection');
