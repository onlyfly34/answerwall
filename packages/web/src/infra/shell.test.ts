import { describe, expect, test, vi } from 'vitest';
import { API_VERSION } from '@answerwall/core/protocol';
import type { Meta } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { Updater } from '../pwa/updater.ts';
import { createShell } from './shell.ts';
import { TEST_VERSION, testMeta } from './test-support.ts';

function harness(meta: Meta = testMeta()) {
  const order: string[] = [];
  const api = {
    getMeta: vi.fn(async () => {
      order.push('meta');
      return meta;
    }),
    logout: vi.fn(async () => undefined),
  };
  const settings = {
    load: vi.fn(async () => {
      order.push('settings');
    }),
  };
  const providers = {
    load: vi.fn(async () => {
      order.push('providers');
    }),
  };
  const asks = { clear: vi.fn() };
  const updater = {
    apply: vi.fn<Updater['apply']>(async () => true),
    settled: vi.fn<Updater['settled']>(),
  };
  const setMeta = vi.fn<(value: Meta) => void>();
  const shell = createShell({
    api,
    settings,
    providers,
    asks,
    updater,
    buildVersion: TEST_VERSION,
    setMeta,
  });
  return { shell, api, settings, providers, asks, updater, setMeta, order };
}

const unauthorized = () => new ApiError('unauthorized', 401, 'no session');

describe('start-up', () => {
  test('asks the server who it is, then loads settings and providers, then is ready', async () => {
    const h = harness();
    expect(h.shell.phase()).toBe('loading');

    await h.shell.start();

    expect(h.order[0]).toBe('meta');
    expect(h.order.slice(1).sort()).toEqual(['providers', 'settings']);
    expect(h.setMeta).toHaveBeenCalledWith(testMeta());
    expect(h.shell.phase()).toBe('ready');
    expect(h.updater.settled).toHaveBeenCalledTimes(1);
    expect(h.updater.apply).not.toHaveBeenCalled();
    expect(h.shell.updateAvailable()).toBe(false);
  });

  test('a device without a session lands on sign-in', async () => {
    const h = harness();
    h.settings.load.mockRejectedValueOnce(unauthorized());

    await h.shell.start();

    expect(h.shell.phase()).toBe('signed-out');
  });

  test('an unreachable server is its own state, and retrying recovers', async () => {
    const h = harness();
    h.api.getMeta.mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'));

    await h.shell.start();
    expect(h.shell.phase()).toBe('unreachable');
    expect(h.settings.load).not.toHaveBeenCalled();

    await h.shell.start();
    expect(h.shell.phase()).toBe('ready');
  });

  test('a server error is shown with its cause', async () => {
    const h = harness();
    const failure = new ApiError('internal', 500, 'oops');
    h.providers.load.mockRejectedValueOnce(failure);

    await h.shell.start();

    expect(h.shell.phase()).toBe('failed');
    expect(h.shell.failure()).toBe(failure);
  });

  test('only the newest start decides the phase', async () => {
    const h = harness();
    let releaseFirst!: () => void;
    h.settings.load.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (releaseFirst = () => reject(unauthorized()))),
    );

    const first = h.shell.start();
    await Promise.resolve();
    await Promise.resolve();
    const second = h.shell.start();
    await second;
    expect(h.shell.phase()).toBe('ready');

    releaseFirst();
    await first;
    expect(h.shell.phase()).toBe('ready');
  });
});

describe('version mismatch', () => {
  test.each([
    ['another apiVersion', testMeta({ apiVersion: API_VERSION + 1 })],
    ['another version', testMeta({ version: '9.9.9' })],
  ])(
    'a server with %s makes the shell stale: it updates instead of mounting pages',
    async (_n, meta) => {
      const h = harness(meta);

      await h.shell.start();

      expect(h.shell.phase()).toBe('stale');
      expect(h.updater.apply).toHaveBeenCalledWith(`${meta.version}/${meta.apiVersion}`);
      expect(h.updater.settled).not.toHaveBeenCalled();
      expect(h.settings.load).not.toHaveBeenCalled();
      expect(h.providers.load).not.toHaveBeenCalled();
      expect(h.setMeta).toHaveBeenCalledWith(meta);
    },
  );

  test('the user can force the update from the stale screen', async () => {
    const meta = testMeta({ version: '9.9.9' });
    const h = harness(meta);
    h.updater.apply.mockResolvedValueOnce(false);
    await h.shell.start();

    await h.shell.applyUpdate();

    expect(h.updater.apply).toHaveBeenLastCalledWith(`9.9.9/${API_VERSION}`, true);
  });

  test('a server upgraded behind an open page raises a notice instead of reloading', async () => {
    const h = harness();
    await h.shell.start();
    h.api.getMeta.mockResolvedValueOnce(testMeta({ version: '2.0.0' }));

    await h.shell.checkVersion();

    expect(h.shell.updateAvailable()).toBe(true);
    expect(h.shell.phase()).toBe('ready');
    expect(h.updater.apply).not.toHaveBeenCalled();

    await h.shell.applyUpdate();
    expect(h.updater.apply).toHaveBeenCalledWith(`2.0.0/${API_VERSION}`, true);
  });

  test('checking the version changes nothing when it is the same or the server is away', async () => {
    const h = harness();
    await h.shell.start();

    await h.shell.checkVersion();
    h.api.getMeta.mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'));
    await h.shell.checkVersion();

    expect(h.shell.updateAvailable()).toBe(false);
    expect(h.shell.phase()).toBe('ready');
  });

  test('the version is not checked before the shell is ready', async () => {
    const h = harness();
    await h.shell.checkVersion();
    expect(h.api.getMeta).not.toHaveBeenCalled();
  });
});

describe('session', () => {
  test('a lost session returns to sign-in and stops following the ask', async () => {
    const h = harness();
    await h.shell.start();

    h.shell.signedOut();

    expect(h.shell.phase()).toBe('signed-out');
    expect(h.asks.clear).toHaveBeenCalledTimes(1);
  });

  test('signing in loads the data without asking for the meta again', async () => {
    const h = harness();
    h.settings.load.mockRejectedValueOnce(unauthorized());
    await h.shell.start();
    expect(h.api.getMeta).toHaveBeenCalledTimes(1);

    await h.shell.signedIn();

    expect(h.shell.phase()).toBe('ready');
    expect(h.api.getMeta).toHaveBeenCalledTimes(1);
    expect(h.settings.load).toHaveBeenCalledTimes(2);
  });

  test('a 401 that arrives while the data loads does not get overwritten by that load', async () => {
    const h = harness();
    let finish!: () => void;
    h.settings.load.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const starting = h.shell.start();
    await Promise.resolve();
    await Promise.resolve();

    h.shell.signedOut();
    finish();
    await starting;

    expect(h.shell.phase()).toBe('signed-out');
  });

  test('logout ends the session on the server first', async () => {
    const h = harness();
    await h.shell.start();

    await h.shell.logout();

    expect(h.api.logout).toHaveBeenCalledTimes(1);
    expect(h.shell.phase()).toBe('signed-out');
  });

  test('a failed logout rejects and keeps the session', async () => {
    const h = harness();
    await h.shell.start();
    h.api.logout.mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'));

    await expect(h.shell.logout()).rejects.toMatchObject({ code: 'network' });
    expect(h.shell.phase()).toBe('ready');
  });

  test.each(['stale', 'unreachable'] as const)(
    'a 401 while the shell is %s does not show sign-in',
    async (phase) => {
      const h = harness(phase === 'stale' ? testMeta({ version: '9.9.9' }) : testMeta());
      if (phase === 'unreachable') {
        h.api.getMeta.mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'));
      }
      await h.shell.start();

      h.shell.signedOut();

      expect(h.shell.phase()).toBe(phase);
    },
  );
});
