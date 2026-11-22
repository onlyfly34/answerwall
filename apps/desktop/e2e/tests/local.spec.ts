import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { arrange, expect, pageApi, send, showCell, test, until } from '../support/fixtures.ts';
import { killTree, processesMentioning } from '../support/processes.ts';

const MOCK_ANSWER = 'Hello from the mock CLI.';

/**
 * The launch token, read off the wire: the browser's own record of what it
 * sent for a request to the local server. The page's scripts have no such view.
 */
async function tokenOnTheWire(page: Page): Promise<string> {
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().endsWith('/api/settings')),
    page.evaluate(() => fetch('/api/settings').then((response) => response.status)),
  ]);
  const header = (await request.allHeaders())['authorization'] ?? '';
  expect(header, 'the Authorization header the main process added').toMatch(/^Bearer \S{40,}$/);
  return header.slice('Bearer '.length);
}

test.describe('local mode', () => {
  test('an ask streams from the mock CLIs through the local server', async ({ local }) => {
    const { app, page, origin } = local;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const meta = await pageApi<{ mode: string; name: string }>(page, 'GET', '/api/meta');
    expect(meta.json).toMatchObject({ name: 'AnswerWall', mode: 'desktop' });

    await arrange(page, [
      { slotId: 'a', providerId: 'claude', model: 'mock-slow' },
      { slotId: 'b', providerId: 'codex' },
      { slotId: 'c', providerId: 'grok' },
    ]);
    await send(page, 'What is the answer?');

    for (const slotId of ['a', 'b', 'c']) {
      const cell = await showCell(page, slotId);
      await expect(cell).toHaveAttribute('data-phase', 'done');
      await expect(cell.locator('.wall-markdown')).toContainText(MOCK_ANSWER);
    }

    const calls = app.mockInvocations().filter((call) => call.prompt === 'What is the answer?');
    expect(calls.map((call) => call.kind).sort()).toEqual(['claude', 'codex', 'grok']);
  });

  test('the launch token reaches the server but never the page or a CLI', async ({ local }) => {
    const { app, page, origin } = local;
    const token = await tokenOnTheWire(page);

    // It is what the server accepts, and the only thing: this is the real token.
    const withToken = await fetch(`${origin}/api/settings`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(withToken.status).toBe(200);
    expect((await fetch(`${origin}/api/settings`)).status).toBe(401);

    // Everything a script in the page can look at.
    const visible = await page.evaluate(async () => {
      const response = await fetch('/api/settings');
      const globals: string[] = [];
      for (const name of Object.getOwnPropertyNames(window)) {
        try {
          const value: unknown = (window as unknown as Record<string, unknown>)[name];
          if (typeof value === 'string') globals.push(value);
          else if (typeof value === 'object' && value !== null && name.startsWith('answerwall')) {
            globals.push(JSON.stringify(Object.keys(value)));
          }
        } catch {
          // A getter that refuses to be read holds nothing for the page either.
        }
      }
      return JSON.stringify({
        status: response.status,
        responseHeaders: [...response.headers.entries()],
        body: await response.text(),
        cookie: document.cookie,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        location: location.href,
        referrer: document.referrer,
        html: document.documentElement.outerHTML,
        resources: performance.getEntries().map((entry) => entry.name),
        globals,
      });
    });
    expect(JSON.parse(visible)).toMatchObject({ status: 200 });
    expect(visible).not.toContain(token);
    const cookies = await page.context().cookies();
    expect(JSON.stringify(cookies)).not.toContain(token);

    // The bridge is one function, and the page cannot make it run anything else.
    const bridge = await page.evaluate(async () => {
      const exposed = (window as unknown as Record<string, Record<string, unknown>>)[
        'answerwallDesktop'
      ];
      const open = exposed?.['openLoginTerminal'] as (kind: unknown) => Promise<unknown>;
      return {
        keys: Object.keys(exposed ?? {}),
        node: typeof (window as unknown as Record<string, unknown>)['require'],
        process: typeof (window as unknown as Record<string, unknown>)['process'],
        answers: await Promise.all(
          ['calc.exe', 'claude && calc', 'openai-compat', null, { kind: 'claude' }].map((kind) =>
            open(kind),
          ),
        ),
      };
    });
    expect(bridge.keys).toEqual(['openLoginTerminal']);
    expect([bridge.node, bridge.process]).toEqual(['undefined', 'undefined']);
    expect(bridge.answers).toEqual(
      Array.from({ length: 5 }, () => ({ ok: false, reason: 'unknown_provider' })),
    );

    // A CLI child gets neither the token nor any of the app's own variables.
    await arrange(page, [{ slotId: 'a', providerId: 'claude' }]);
    await send(page, 'Hello');
    await expect(await showCell(page, 'a')).toHaveAttribute('data-phase', 'done');
    const log = await readFile(app.profile.mockLog, 'utf8');
    expect(log).toContain('"prompt":"Hello"');
    expect(log).not.toContain(token);
    expect(log).not.toMatch(/ANSWERWALL_/);

    // Nor does the log file.
    expect(await app.log()).not.toContain(token);
  });

  test('the token goes to the local server’s origin and nowhere else', async ({ local }) => {
    const { app, page } = local;
    const token = await tokenOnTheWire(page);

    // Another server on this machine, as close to the local one as an origin can be.
    const seen: { url: string; authorization: string | undefined }[] = [];
    const other = createServer((request, response) => {
      seen.push({ url: request.url ?? '', authorization: request.headers.authorization });
      response.end('ok');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      // From the page: its own policy and the session both refuse.
      const fromPage = await page.evaluate(async (url) => {
        try {
          await fetch(url, { mode: 'no-cors' });
          return 'sent';
        } catch {
          return 'refused';
        }
      }, `${otherOrigin}/from-page`);
      expect(fromPage).toBe('refused');

      // From the main process, through the local window's own session.
      const fromSession = await app.electron.evaluate(async ({ session }, url) => {
        try {
          const response = await session.fromPartition('persist:local').fetch(url);
          return `sent: ${response.status}`;
        } catch {
          return 'refused';
        }
      }, `${otherOrigin}/from-session`);
      expect(fromSession).toBe('refused');

      // Through any other session the request leaves, without the token.
      const elsewhere = await app.electron.evaluate(async ({ session }, url) => {
        const response = await session.fromPartition('persist:remote').fetch(url);
        return response.status;
      }, `${otherOrigin}/from-elsewhere`);
      expect(elsewhere).toBe(200);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
    expect(seen.map((request) => request.url)).toEqual(['/from-elsewhere']);
    expect(JSON.stringify(seen)).not.toContain(token);
  });

  test('links open in the system browser; the window never leaves its origin', async ({
    local,
  }) => {
    const { app, page, origin } = local;
    // What would reach the system is recorded instead: no browser starts in a test.
    await app.electron.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { openedExternally: string[] }).openedExternally = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const opened = (): Promise<string[]> =>
      app.electron.evaluate(
        () => (globalThis as unknown as { openedExternally: string[] }).openedExternally,
      );
    const windows = app.electron.windows().length;

    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://example.com/docs?x=1';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'external';
      document.body.append(link);
      link.click();
      window.open('https://example.org/popup');
      // Not web links: these go nowhere at all.
      window.open('file:///etc/passwd');
      window.open('ms-settings:privacy');
      window.open(`${location.origin}/history`);
    });
    await expect
      .poll(opened)
      .toEqual(['https://example.com/docs?x=1', 'https://example.org/popup']);
    expect(app.electron.windows()).toHaveLength(windows);

    // Navigating the window itself away is refused.
    await page.evaluate(() => {
      location.href = 'https://example.com/elsewhere';
    });
    await page.waitForTimeout(500);
    // Asked of the main process: the test driver itself keeps waiting for a
    // navigation that was refused.
    const after = await app.electron.evaluate(async ({ webContents }) => {
      const content = webContents.getAllWebContents().find((one) => /^http/.test(one.getURL()));
      return {
        url: content?.getURL(),
        wall: (await content?.executeJavaScript(
          'document.querySelector("form.wall-composer") !== null',
        )) as boolean,
      };
    });
    expect(new URL(after.url ?? '').origin).toBe(origin);
    expect(after.wall).toBe(true);
    expect(await opened()).toHaveLength(2);
  });

  test('the page may write to the clipboard and is granted nothing else', async ({ local }) => {
    const { page } = local;

    const states = await page.evaluate(async () => {
      const names = ['clipboard-write', 'geolocation', 'notifications', 'camera', 'microphone'];
      const result: Record<string, string> = {};
      for (const name of names) {
        try {
          const status = await navigator.permissions.query({ name: name as PermissionName });
          result[name] = status.state;
        } catch {
          result[name] = 'unsupported';
        }
      }
      return result;
    });

    expect(states['clipboard-write']).toBe('granted');
    for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
      expect(states[name], name).toBe('denied');
    }
  });

  test('a provider’s login opens an external terminal with the official command', async ({
    local,
  }) => {
    const { page } = local;
    await page.getByRole('navigation').getByRole('link', { name: 'Providers' }).click();
    const claude = page.getByRole('region', { name: 'Claude', exact: true });
    await expect(claude.getByText('claude auth login')).toBeVisible();
    const open = claude.getByRole('button', { name: 'Open a terminal to log in to Claude' });

    if (process.platform === 'win32') {
      await open.click();
      await expect(page.getByText('A terminal window was opened.')).toBeVisible();
      // A console window of its own, which stays open after the command. The
      // command on the sandbox PATH is the mock; no real CLI is reachable.
      const consoles = await until(
        'the terminal to appear',
        async () => {
          const found = await processesMentioning('/k claude auth login');
          return found.length > 0 ? found : undefined;
        },
        30_000,
      );
      for (const terminal of consoles) await killTree(terminal.pid);
      await until('the terminal to be gone', async () => {
        return (await processesMentioning('/k claude auth login')).length === 0;
      });
    } else {
      // The sandbox PATH holds no terminal program, so the app can only say so.
      await open.click();
      await expect(page.getByText('No terminal could be opened.')).toBeVisible();
    }
  });

  test('an API key is stored encrypted, outside the database', async ({ local }) => {
    const { app, page } = local;
    const available = await app.electron.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    );
    const current = await pageApi<{ settings: { providers: unknown[] } }>(
      page,
      'GET',
      '/api/settings',
    );
    const saved = await pageApi<{ settings: { providers: { id: string; hasApiKey?: boolean }[] } }>(
      page,
      'PUT',
      '/api/settings',
      {
        providers: [
          ...current.json.settings.providers,
          {
            id: 'home',
            kind: 'openai-compat',
            label: 'Home',
            enabled: true,
            concurrency: 1,
            models: [],
            baseUrl: 'http://127.0.0.1:9',
            apiKey: 'sk-desktop-e2e-0123456789',
          },
        ],
      },
    );
    const secretsFile = path.join(app.profile.userData, 'secrets.json');

    if (!available) {
      // No system encryption (a Linux session without a keyring): refused, nothing written.
      expect(saved.status).toBe(409);
      expect(await readFile(secretsFile, 'utf8').catch(() => '')).not.toContain('sk-desktop');
      return;
    }

    expect(saved.status).toBe(200);
    expect(saved.json.settings.providers.find((provider) => provider.id === 'home')).toMatchObject({
      hasApiKey: true,
    });
    const stored = await readFile(secretsFile, 'utf8');
    expect(stored).toContain('provider.home.api-key');
    expect(stored).not.toContain('sk-desktop-e2e-0123456789');
    // Nowhere else in the user data either: not in the database, not in the log.
    for (const file of ['data/answerwall.sqlite', 'logs/desktop.log', 'desktop.json']) {
      const content = await readFile(path.join(app.profile.userData, file)).catch(() => undefined);
      expect(content?.includes('sk-desktop-e2e-0123456789') ?? false, file).toBe(false);
    }
    expect(JSON.stringify(saved.json)).not.toContain('sk-desktop-e2e-0123456789');
  });
});
