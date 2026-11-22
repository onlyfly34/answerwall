/**
 * Fixtures of the web-cell tests: a real Chromium with its own profile and
 * the unpacked test extension, the stand-in vendor site, and a plain web page
 * on a third origin that tries what a hostile page would try.
 */
import { test as base, chromium, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { webCellsExtensionDir } from '../../support/environment.ts';
import { DEFAULT_SERVER_OPTIONS, startServer } from '../../support/server.ts';
import type { TestServer } from '../../support/server.ts';
import { startVendorSite } from './vendor-site.ts';
import type { VendorSite } from './vendor-site.ts';

/** What `extension/wall.js` puts on the wall page's window. */
export interface WallApi {
  ready: Promise<{ tabId: number; extensionId: string }>;
  ask(prompt: string): Promise<{ ok: boolean; text?: string; reason?: string }>;
  activeFrames(): number;
  sessionRules(): Promise<{ id: number; condition: Record<string, unknown> }[]>;
  api(
    base: string,
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; allowOrigin: string | null }>;
  stream(
    base: string,
    token: string,
    path: string,
  ): Promise<{ status: number; chunks: number; events: { type: string; seq: number }[] }>;
}

declare global {
  interface Window {
    wall: WallApi;
  }
  /** The part of the extension API the tests call from inside an extension page. */
  const chrome: {
    storage: {
      local: {
        get(keys: string | string[]): Promise<Record<string, unknown>>;
        set(items: Record<string, unknown>): Promise<void>;
      };
    };
    declarativeNetRequest: {
      getSessionRules(): Promise<{ id: number; condition: Record<string, unknown> }[]>;
    };
  };
}

/** A web page on its own origin that frames whatever address it is given. */
export interface Bystander {
  origin: string;
  /** The address of a page that frames `target`. */
  framing(target: string): string;
  close(): Promise<void>;
}

async function startBystander(): Promise<Bystander> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://bystander.invalid');
    const target = url.searchParams.get('frame') ?? 'about:blank';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><title>Bystander</title><h1>Bystander</h1><iframe id="cell" src="${encodeURI(target)}"></iframe>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    framing: (target) => `${origin}/?frame=${encodeURIComponent(target)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Fixtures {
  /** Start the profile with "block third-party cookies" switched on. */
  blockThirdPartyCookies: boolean;
  context: BrowserContext;
  extensionId: string;
  vendor: VendorSite;
  bystander: Bystander;
  server: TestServer;
  /** Signs in to the stand-in site in an ordinary tab, as a user would. */
  signInToVendor: () => Promise<Page>;
  /** Opens the extension's wall page framing the stand-in site. */
  openWall: (options?: { rule?: 'tab' | 'initiator' | 'none'; path?: string }) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  blockThirdPartyCookies: [false, { option: true }],

  context: async ({ blockThirdPartyCookies }, use, testInfo) => {
    const profile = testInfo.outputPath('profile');
    if (blockThirdPartyCookies) {
      await mkdir(path.join(profile, 'Default'), { recursive: true });
      await writeFile(
        path.join(profile, 'Default', 'Preferences'),
        // chrome://settings/cookies: "Block third-party cookies".
        JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }),
      );
    }
    const context = await chromium.launchPersistentContext(profile, {
      // The bundled Chromium loads extensions in its headless mode; the
      // headless shell does not.
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${webCellsExtensionDir()}`,
        `--load-extension=${webCellsExtensionDir()}`,
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  vendor: async ({}, use) => {
    const vendor = await startVendorSite();
    await use(vendor);
    await vendor.close();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  bystander: async ({}, use) => {
    const bystander = await startBystander();
    await use(bystander);
    await bystander.close();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  server: async ({}, use, testInfo) => {
    const server = await startServer(DEFAULT_SERVER_OPTIONS);
    try {
      await use(server);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server-log', { body: server.logText(), contentType: 'text/plain' });
      }
      await server.stop();
    }
  },

  signInToVendor: async ({ context, vendor }, use) => {
    await use(async () => {
      const tab = await context.newPage();
      await tab.goto(vendor.origin);
      await tab.getByRole('button', { name: 'Sign in' }).click();
      await expect(tab.getByTestId('chat')).toBeVisible();
      return tab;
    });
  },

  openWall: async ({ context, extensionId, vendor }, use) => {
    await use(async ({ rule = 'tab', path: framePath = '/' } = {}) => {
      const wall = await context.newPage();
      const query = new URLSearchParams({ vendor: vendor.origin, rule, path: framePath });
      await wall.goto(`chrome-extension://${extensionId}/wall.html?${query.toString()}`);
      await wall.evaluate(() => window.wall.ready);
      return wall;
    });
  },
});

export { expect };
