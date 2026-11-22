/**
 * The test fixtures. Every test gets its own server (so tests cannot see each
 * other's history, presets, settings or failed sign-in attempts and can run
 * in parallel), and every browser context is watched: a console error, an
 * uncaught exception, a Content-Security-Policy violation or a request to any
 * origin other than the test's server fails the test that caused it.
 */
import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { DEFAULT_SERVER_OPTIONS, startServer } from './server.ts';
import type { ServerOptions, TestServer } from './server.ts';
import { startCanary, startFlakyLink, startStub } from './stub.ts';
import type { Canary, FlakyLink, StubEndpoint } from './stub.ts';

export type Viewport = 'desktop' | 'tablet' | 'phone';

export interface CspViolation {
  directive: string;
  blockedUri: string;
  documentUri: string;
  sample: string;
  /** Where the blocked thing came from: `file:line:column`. */
  source: string;
}

export interface Guard {
  /** Console errors (and warnings Chromium raises for blocked content). */
  consoleErrors: string[];
  pageErrors: string[];
  cspViolations: CspViolation[];
  /** Requests the browser tried to make to another origin; they are aborted. */
  foreignRequests: string[];
  /** Dialogs (`alert`, `confirm`, …) a page tried to open; they are dismissed. */
  dialogs: string[];
  /** Declares console errors this test causes on purpose. */
  allowConsole(...patterns: RegExp[]): void;
  /** Declares one more origin as the server's own (a relay in front of it). */
  trust(origin: string): void;
  /** Watches one more context, for tests that open a second browser. */
  watch(context: BrowserContext): Promise<void>;
}

interface Fixtures {
  /** How this test's server is started; override with `test.use`. */
  serverOptions: ServerOptions;
  server: TestServer;
  stub: StubEndpoint;
  canary: Canary;
  /** A second address of the server whose connections the test can cut. */
  link: FlakyLink;
  guard: Guard;
  device: Viewport;
  /** Pairs this browser context as a device, without going through the sign-in page. */
  signIn: (name?: string) => Promise<void>;
  /** A page of a paired device, on the wall. */
  wallPage: Page;
}

/** A 401 from the API is how the server says "not signed in"; the sign-in page follows. */
const EXPECTED_CONSOLE = [/Failed to load resource: the server responded with a status of 401/];

const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

declare global {
  interface Window {
    __e2eCspViolation?: (violation: CspViolation) => void;
  }
}

export const test = base.extend<Fixtures>({
  serverOptions: [DEFAULT_SERVER_OPTIONS, { option: true }],

  server: async ({ serverOptions }, use, testInfo) => {
    const server = await startServer(serverOptions);
    let survivors: number[];
    try {
      await use(server);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('server-log', { body: server.logText(), contentType: 'text/plain' });
      }
      survivors = await server.stop();
    }
    expect(survivors, 'CLI processes that outlived the server shutdown').toEqual([]);
  },

  baseURL: async ({ server }, use) => {
    await use(server.base);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  stub: async ({}, use) => {
    const stub = await startStub();
    await use(stub);
    await stub.close();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  canary: async ({}, use) => {
    const canary = await startCanary();
    await use(canary);
    await canary.close();
  },

  link: async ({ server, guard }, use) => {
    const link = await startFlakyLink(server.port);
    guard.trust(link.origin);
    await use(link);
    await link.close();
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
  device: async ({}, use, testInfo) => {
    await use(testInfo.project.name as Viewport);
  },

  guard: [
    async ({ context, server }, use, testInfo) => {
      const allowed = [...EXPECTED_CONSOLE];
      const trusted = new Set([server.base]);
      const guard: Guard = {
        consoleErrors: [],
        pageErrors: [],
        cspViolations: [],
        foreignRequests: [],
        dialogs: [],
        allowConsole: (...patterns) => void allowed.push(...patterns),
        trust: (origin) => void trusted.add(origin),
        async watch(target) {
          target.on('console', (message) => {
            const text = message.text();
            const blocked = /Content Security Policy|Refused to /i.test(text);
            if (message.type() !== 'error' && !blocked) return;
            guard.consoleErrors.push(`${text} (${message.location().url})`);
          });
          target.on('weberror', (error) => guard.pageErrors.push(String(error.error())));
          target.on('dialog', (dialog) => {
            guard.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
            void dialog.dismiss().catch(() => undefined);
          });
          await target.exposeBinding('__e2eCspViolation', (_source, violation: CspViolation) => {
            guard.cspViolations.push(violation);
          });
          await target.addInitScript(() => {
            document.addEventListener('securitypolicyviolation', (event) => {
              window.__e2eCspViolation?.({
                directive: event.effectiveDirective,
                blockedUri: event.blockedURI,
                documentUri: event.documentURI,
                sample: event.sample,
                source: `${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
              });
            });
          });
          // Anything that is not this test's server is recorded and never sent.
          await target.route(
            (url) => !LOCAL_SCHEMES.has(url.protocol) && !trusted.has(url.origin),
            async (route) => {
              guard.foreignRequests.push(`${route.request().method()} ${route.request().url()}`);
              await route.abort('blockedbyclient');
            },
          );
        },
      };
      await guard.watch(context);

      await use(guard);

      const unexpected = guard.consoleErrors.filter(
        (text) => !allowed.some((pattern) => pattern.test(text)),
      );
      if (testInfo.status === 'skipped') return;
      expect.soft(guard.foreignRequests, 'requests to another origin').toEqual([]);
      expect.soft(guard.cspViolations, 'Content-Security-Policy violations').toEqual([]);
      expect.soft(guard.pageErrors, 'uncaught exceptions in the page').toEqual([]);
      expect.soft(guard.dialogs, 'dialogs opened by the page').toEqual([]);
      expect.soft(unexpected, 'console errors').toEqual([]);
    },
    { auto: true },
  ],

  signIn: async ({ context, server }, use, testInfo) => {
    await use(async (name = `e2e ${testInfo.project.name}`) => {
      const response = await context.request.post('/api/auth/pair', {
        headers: { origin: server.base },
        data: { code: await server.mintPairingCode(), deviceName: name },
      });
      expect(response.status(), 'pairing through the API').toBe(200);
    });
  },

  wallPage: async ({ page, signIn }, use) => {
    await signIn();
    await page.goto('/');
    await expect(page.getByRole('form', { name: 'Ask' })).toBeVisible();
    await use(page);
  },
});

export { expect };
