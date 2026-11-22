import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_VERSION, createDefaultSettings } from '@answerwall/core/protocol';
import type { Meta, ServerInfo, Settings } from '@answerwall/core/protocol';
import { ServicesContext, useServices } from '../contracts/services.ts';
import { readyProviderStatus } from '../contracts/testing.ts';
import { createServices } from '../infra/services.ts';
import type { ShellServices } from '../infra/services.ts';
import {
  errorResponse,
  fakeVisibility,
  jsonResponse,
  memoryStorage,
  scriptedFetch,
  TEST_VERSION,
  testMeta,
} from '../infra/test-support.ts';
import type { RecordedCall } from '../infra/test-support.ts';
import type { Updater } from '../pwa/updater.ts';
import { App } from './App.tsx';
import { ShellContext } from './shell-context.ts';

// The wall belongs to another unit. These stand-ins record what the shell
// promises it: settings and providers are loaded before a wall page mounts.
const wallMounts: { page: string; settingsLoaded: boolean; providers: number }[] = [];
vi.mock('../wall/index.tsx', () => {
  const page = (name: string) => () => {
    const { settings, providers } = useServices();
    wallMounts.push({
      page: name,
      settingsLoaded: settings.settings() !== undefined,
      providers: providers.providers().length,
    });
    return <h1>{name}</h1>;
  };
  return { WallPage: page('Wall page'), HistoryPage: page('History page') };
});

interface ServerState {
  meta: Meta;
  signedIn: boolean;
  settings: Settings;
  server: ServerInfo;
  /** Replaces the default answer for one path, e.g. to fail it. */
  overrides: Map<string, (call: RecordedCall) => Response>;
  down: boolean;
}

function fakeServer(initial: Partial<ServerState> = {}) {
  const state: ServerState = {
    meta: testMeta(),
    signedIn: true,
    settings: createDefaultSettings(),
    server: {
      mode: 'server',
      tls: { mode: 'off', insecure: false, caCertificatePem: null },
      publicOrigins: [],
    },
    overrides: new Map(),
    down: false,
    ...initial,
  };
  const http = scriptedFetch((call) => {
    if (state.down) throw new TypeError('Failed to fetch');
    const override = state.overrides.get(call.url);
    if (override) return override(call);
    const route = `${call.method} ${call.url}`;
    if (route === 'GET /api/meta') return jsonResponse(state.meta);
    if (route === 'POST /api/auth/pair') {
      state.signedIn = true;
      return jsonResponse({ device: null });
    }
    if (!state.signedIn) return errorResponse('unauthorized', 401);
    switch (route) {
      case 'GET /api/settings':
        return jsonResponse({ settings: state.settings, server: state.server });
      case 'GET /api/providers':
      case 'POST /api/providers/refresh':
        return jsonResponse({ providers: state.settings.providers.map(readyProviderStatus) });
      case 'GET /api/auth/devices':
        return jsonResponse({ devices: [], maxDevices: 8 });
      case 'POST /api/auth/logout':
        state.signedIn = false;
        return jsonResponse({ ok: true });
      default:
        return errorResponse('not_found', 404);
    }
  });
  return { state, http };
}

function start(path: string, initial: Partial<ServerState> = {}) {
  window.history.replaceState({}, '', path);
  const server = fakeServer(initial);
  const updater = {
    apply: vi.fn<Updater['apply']>(async () => true),
    settled: vi.fn<Updater['settled']>(),
  };
  const services: ShellServices = createServices({
    fetch: server.http.fetch,
    updater,
    buildVersion: TEST_VERSION,
    visibility: fakeVisibility(),
    language: { storage: memoryStorage(), preferred: ['en'], root: { lang: '' } },
  });
  render(() => (
    <ServicesContext.Provider value={services}>
      <ShellContext.Provider value={services}>
        <App />
      </ShellContext.Provider>
    </ServicesContext.Provider>
  ));
  const requests = () => server.http.calls.map((call) => `${call.method} ${call.url}`);
  return { ...server, services, updater, requests };
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
/** The status line of the full-page screen; the toast region is a status of its own. */
const statusText = () => within(screen.getByRole('main')).getByRole('status').textContent;

beforeEach(() => {
  wallMounts.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('start-up', () => {
  test('the server is identified first, then settings and providers load, then the page mounts', async () => {
    const app = start('/providers');
    expect(statusText()).toBe('Loading…');

    await heading('Providers');

    expect(app.requests()[0]).toBe('GET /api/meta');
    expect(app.requests().slice(1, 3).sort()).toEqual(['GET /api/providers', 'GET /api/settings']);
    expect(app.services.meta()).toEqual(testMeta());
    expect(app.updater.settled).toHaveBeenCalledTimes(1);
    for (const call of app.http.calls) expect(call.init.credentials).toBe('same-origin');
  });

  test('wall pages mount only once settings and providers are loaded', async () => {
    start('/');
    await heading('Wall page');
    fireEvent.click(screen.getByRole('link', { name: 'History' }));
    await heading('History page');

    expect(wallMounts).toEqual([
      { page: 'Wall page', settingsLoaded: true, providers: 5 },
      { page: 'History page', settingsLoaded: true, providers: 5 },
    ]);
  });

  test('the navigation reaches every page and marks the current one', async () => {
    start('/providers');
    await heading('Providers');
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));

    expect(
      nav.getAllByRole<HTMLAnchorElement>('link').map((link) => [link.textContent, link.pathname]),
    ).toEqual([
      ['Wall', '/'],
      ['History', '/history'],
      ['Providers', '/providers'],
      ['Settings', '/settings'],
    ]);
    expect(nav.getByRole('link', { name: 'Providers' }).classList.contains('is-active')).toBe(true);
    expect(nav.getByRole('link', { name: 'Wall' }).classList.contains('is-active')).toBe(false);

    fireEvent.click(nav.getByRole('link', { name: 'Settings' }));
    await heading('Settings');
    expect(window.location.pathname).toBe('/settings');
  });

  test('the skip link moves the focus to the page content', async () => {
    start('/providers');
    await heading('Providers');

    fireEvent.click(screen.getByRole('button', { name: 'Skip to content' }));

    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  test('an unknown address shows a way back', async () => {
    start('/no/such/page');

    await heading('Page not found');
    expect(screen.getByRole<HTMLAnchorElement>('link', { name: 'Back to the wall' }).pathname).toBe(
      '/',
    );
  });

  test('the language saved on the server becomes the language of this device', async () => {
    const app = start('/providers', {
      settings: { ...createDefaultSettings(), language: 'zh-TW' },
    });

    await heading('供應商');
    expect(app.services.i18n.language()).toBe('zh-TW');
    expect(screen.getByRole('navigation', { name: '主選單' })).toBeDefined();
  });
});

describe('sign-in', () => {
  test('without a session the app shows sign-in, then returns to the page that was asked for', async () => {
    const app = start('/settings', { signedIn: false });

    const submit = await screen.findByRole('button', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/sign-in');
    expect(screen.queryByRole('navigation')).toBeNull();

    const code = screen.getByLabelText<HTMLInputElement>('Pairing code', {
      selector: 'input:not([type=radio])',
    });
    code.value = '12345678';
    fireEvent.input(code);
    fireEvent.click(submit);

    await heading('Settings');
    expect(window.location.pathname).toBe('/settings');
    expect(app.requests()).toContain('POST /api/auth/pair');
    expect(app.requests().filter((request) => request === 'GET /api/meta')).toHaveLength(1);
  });

  test('a 401 on any later request returns to sign-in', async () => {
    const app = start('/providers');
    await heading('Providers');
    app.state.signedIn = false;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    await screen.findByRole('button', { name: 'Sign in' });
    expect(window.location.pathname).toBe('/sign-in');
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
    // Going back to sign-in is the whole reaction: no error toast on top of it.
    expect(app.services.notify.toasts()).toEqual([]);
  });

  test('signing out ends the session on the server and shows sign-in', async () => {
    const app = start('/settings');
    await heading('Settings');

    const signOut = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign out' });
    // Disabled until the device list has loaded.
    await waitFor(() => expect(signOut.disabled).toBe(false));

    fireEvent.click(signOut);

    await screen.findByRole('button', { name: 'Sign in' });
    expect(app.requests()).toContain('POST /api/auth/logout');
    expect(app.state.signedIn).toBe(false);
  });
});

describe('when the server and this page disagree', () => {
  test.each([
    ['version', testMeta({ version: '9.9.9' })],
    ['API version', testMeta({ apiVersion: API_VERSION + 1 })],
  ])('another %s: the shell updates itself instead of mounting pages', async (_name, meta) => {
    const app = start('/providers', { meta });

    await waitFor(() =>
      expect(app.updater.apply).toHaveBeenCalledWith(`${meta.version}/${meta.apiVersion}`),
    );
    expect(statusText()).toContain(meta.version);
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull();
    expect(app.requests()).toEqual(['GET /api/meta']);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.updater.apply).toHaveBeenLastCalledWith(
        `${meta.version}/${meta.apiVersion}`,
        true,
      ),
    );
  });

  test('a server updated behind an open page is announced; the user chooses when to reload', async () => {
    const app = start('/providers');
    await heading('Providers');
    app.state.meta = testMeta({ version: '2.0.0' });

    await app.services.shell.checkVersion();

    expect(
      await screen.findByText('The server was updated. Reload to use the new version.'),
    ).toBeDefined();
    expect(app.updater.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.updater.apply).toHaveBeenCalledWith(`2.0.0/${API_VERSION}`, true),
    );
  });

  test('returning to the page checks the server version, at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const app = start('/providers');
      await heading('Providers');
      const metaRequests = () => app.requests().filter((r) => r === 'GET /api/meta').length;
      app.state.meta = testMeta({ version: '2.0.0' });

      document.dispatchEvent(new Event('visibilitychange'));
      expect(metaRequests()).toBe(1);

      vi.setSystemTime(Date.now() + 60_000);
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(metaRequests()).toBe(2);
      expect(
        await screen.findByText('The server was updated. Reload to use the new version.'),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a response this page cannot read makes it look at the server version again', async () => {
    const app = start('/providers');
    await heading('Providers');
    app.state.meta = testMeta({ version: '2.0.0' });
    app.state.overrides.set('/api/providers/refresh', () => jsonResponse({ unexpected: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(
      await screen.findByText('The server was updated. Reload to use the new version.'),
    ).toBeDefined();
  });
});

describe('when the server is away', () => {
  test('an unreachable server is explained and can be retried', async () => {
    const app = start('/providers', { down: true });

    expect((await screen.findByRole('alert')).textContent).toBe('The server cannot be reached.');
    expect(screen.queryByRole('navigation')).toBeNull();

    app.state.down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await heading('Providers');
  });

  test('opened offline, the cached shell says so and loads by itself once the device is online', async () => {
    vi.stubGlobal('navigator', Object.create(navigator, { onLine: { value: false } }));
    const app = start('/providers', { down: true });

    await screen.findByRole('alert');
    expect(screen.getByText('This device is offline.', { exact: false })).toBeDefined();

    app.state.down = false;
    vi.stubGlobal('navigator', Object.create(navigator, { onLine: { value: true } }));
    window.dispatchEvent(new Event('online'));
    await heading('Providers');
  });

  test('a server error during start-up is shown with a retry', async () => {
    const app = start('/providers');
    app.state.overrides.set('/api/settings', () => errorResponse('internal', 500));

    expect((await screen.findByRole('alert')).textContent).toBe('The server ran into an error.');

    app.state.overrides.clear();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await heading('Providers');
  });

  test('going offline shows the offline shell message until the connection returns', async () => {
    start('/providers');
    await heading('Providers');
    expect(screen.queryByText('This device is offline.', { exact: false })).toBeNull();

    vi.stubGlobal('navigator', Object.create(navigator, { onLine: { value: false } }));
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByText('This device is offline.', { exact: false })).toBeDefined();

    vi.stubGlobal('navigator', Object.create(navigator, { onLine: { value: true } }));
    window.dispatchEvent(new Event('online'));
    await waitFor(() =>
      expect(screen.queryByText('This device is offline.', { exact: false })).toBeNull(),
    );
  });
});

describe('notices and toasts', () => {
  test('insecure mode shows a warning banner on every page', async () => {
    start('/providers', {
      server: {
        mode: 'server',
        tls: { mode: 'off', insecure: true, caCertificatePem: null },
        publicOrigins: [],
      },
    });
    await heading('Providers');

    const banner = screen
      .getAllByRole('alert')
      .find((alert) => alert.classList.contains('app-notice'));
    expect(banner?.textContent).toContain('accepts unencrypted connections from other machines');
  });

  test('a secure server shows no banner', async () => {
    start('/providers');
    await heading('Providers');
    expect(document.querySelector('.app-notice')).toBeNull();
  });

  test('toasts are announced politely and can be dismissed', async () => {
    const app = start('/providers');
    await heading('Providers');

    app.services.notify.toast({ kind: 'success', message: 'Saved.' });

    const toast = await screen.findByText('Saved.');
    expect(toast.closest('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Saved.')).toBeNull());
  });

  test('a failed request becomes a translated error toast', async () => {
    const app = start('/providers');
    await heading('Providers');
    app.state.overrides.set('/api/providers/refresh', () => errorResponse('internal', 500));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    expect(await screen.findByText('The server ran into an error.')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Providers' })).toBeDefined();
  });
});
