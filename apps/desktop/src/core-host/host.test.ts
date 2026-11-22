import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AppError, createServer } from '@answerwall/core';
import type { ServerHandle } from '@answerwall/core';
import { createMemoryLogger } from '@answerwall/core/testing';
import type { HostConfig, HostEvent } from '../shared/ipc.ts';
import { createBridgedSecretStore, desktopConfig, runHost, SHUTDOWN_TIMEOUT_MS } from './host.ts';
import type { HostDeps } from './host.ts';

const TOKEN = 'launch-token-0123456789abcdef0123456789';

const config = (overrides: Partial<HostConfig> = {}): HostConfig => ({
  version: '1.2.3',
  port: 0,
  dataDir: '/data',
  webRoot: '/web',
  token: TOKEN,
  logLevel: 'info',
  reaper: '/reaper.cjs',
  ...overrides,
});

function setup(overrides: Partial<HostDeps> = {}) {
  const posted: HostEvent[] = [];
  const exits: number[] = [];
  const timers: { ms: number; task: () => void; cancelled: boolean }[] = [];
  const reported: [number, string][] = [];
  const logger = createMemoryLogger();
  let deliver: (message: unknown) => void = () => undefined;
  let killed = 0;
  let waiters: (() => void)[] = [];

  runHost({
    port: {
      postMessage(message) {
        posted.push(message);
        for (const wake of waiters) wake();
        waiters = [];
      },
      onMessage(listener) {
        deliver = listener;
      },
    },
    createServer,
    logger,
    // No CLI can be found: the detection at start runs nothing.
    env: { PATH: '' },
    watchChildren(listener) {
      listener(4321, 'started');
      return () => undefined;
    },
    killChildren: () => void (killed += 1),
    startReaper: () => ({ report: (pid, state) => void reported.push([pid, state]) }),
    exit: (code) => {
      exits.push(code);
      for (const wake of waiters) wake();
      waiters = [];
    },
    schedule(ms, task) {
      const timer = { ms, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });

  /** Resolves once the host has posted a message of this type or exited. */
  const next = async <T extends HostEvent['type']>(
    type: T,
  ): Promise<Extract<HostEvent, { type: T }> | undefined> => {
    for (;;) {
      const found = posted.find((message) => message.type === type);
      if (found) return found as Extract<HostEvent, { type: T }>;
      if (exits.length > 0) return undefined;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  const exited = async (): Promise<number> => {
    while (exits.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
    return exits[0] ?? -1;
  };

  return {
    send: (message: unknown) => deliver(message),
    posted,
    exits,
    timers,
    reported,
    logger,
    killed: () => killed,
    next,
    exited,
  };
}

describe('desktopConfig', () => {
  test('is loopback only, plain HTTP, with the launch token as the only credential', () => {
    expect(desktopConfig(config({ port: 41873 }))).toEqual({
      mode: 'desktop',
      version: '1.2.3',
      host: '127.0.0.1',
      port: 41873,
      dataDir: '/data',
      webRoot: '/web',
      publicOrigins: [],
      trustedProxies: [],
      tls: { mode: 'off' },
      allowInsecure: false,
      staticToken: TOKEN,
      logLevel: 'info',
    });
  });
});

describe('runHost with the real server', () => {
  let dataDir: string | undefined;
  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 10 });
    dataDir = undefined;
  });

  test('serves in desktop mode, accepts the launch token only, and stops on request', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'desktop-host-'));
    const host = setup();

    host.send({ type: 'start', config: config({ dataDir }) });
    const listening = await host.next('listening');
    const base = `http://127.0.0.1:${listening?.port}`;

    const meta = (await (await fetch(`${base}/api/meta`)).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ mode: 'desktop', version: '1.2.3', tls: 'off' });

    expect((await fetch(`${base}/api/settings`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/settings`, {
          headers: { authorization: 'Bearer wrong-token-000000' },
        })
      ).status,
    ).toBe(401);
    const authorised = await fetch(`${base}/api/settings`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorised.status).toBe(200);
    // A local instance pairs no devices: the token is the only way in.
    const pairing = await fetch(`${base}/api/auth/pairing-codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(pairing.status).toBe(403);

    // The helper hears of the children from the start.
    expect(host.reported).toEqual([[4321, 'started']]);
    // Neither the log nor the environment of the children holds the token.
    expect(JSON.stringify(host.logger.entries)).not.toContain(TOKEN);

    host.send({ type: 'shutdown' });
    expect(await host.exited()).toBe(0);
    expect(host.killed()).toBe(0);
    await expect(fetch(`${base}/api/meta`)).rejects.toThrow();
  });

  test('the server’s secrets go through the bridge to the main process', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'desktop-host-'));
    const host = setup();
    host.send({ type: 'start', config: config({ dataDir }) });
    const listening = await host.next('listening');
    const base = `http://127.0.0.1:${listening?.port}`;
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    const current = (await (await fetch(`${base}/api/settings`, { headers })).json()) as {
      settings: { providers: unknown[] };
    };
    const saving = fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        providers: [
          ...current.settings.providers,
          {
            id: 'home',
            kind: 'openai-compat',
            label: 'Home',
            enabled: true,
            concurrency: 1,
            models: [],
            baseUrl: 'http://127.0.0.1:9',
            apiKey: 'sk-through-the-bridge',
          },
        ],
      }),
    });

    // Answer whatever the server asks of the store until the key arrives.
    const stored = new Map<string, string>();
    let answered = 0;
    const serve = (): void => {
      for (const request of host.posted.slice(answered)) {
        answered += 1;
        if (request.type !== 'secret') continue;
        if (request.op === 'set') stored.set(request.key, request.value);
        if (request.op === 'delete') stored.delete(request.key);
        const value = request.op === 'get' ? stored.get(request.key) : undefined;
        host.send({
          type: 'secret-result',
          id: request.id,
          ok: true,
          ...(value === undefined ? {} : { value }),
        });
      }
    };
    const pump = setInterval(serve, 5);
    const response = await saving;
    clearInterval(pump);

    expect(response.status).toBe(200);
    expect([...stored]).toEqual([['provider.home.api-key', 'sk-through-the-bridge']]);
    expect(JSON.stringify(await response.json())).not.toContain('sk-through-the-bridge');

    host.send({ type: 'shutdown' });
    const closing = setInterval(serve, 5);
    expect(await host.exited()).toBe(0);
    clearInterval(closing);
  });
});

describe('runHost', () => {
  const fakeServer = (overrides: Partial<ServerHandle> = {}): ServerHandle =>
    ({
      listen: async () => ({ port: 50123, url: 'http://127.0.0.1:50123' }),
      shutdown: async () => undefined,
      ...overrides,
    }) as ServerHandle;

  test('gives the server the desktop configuration, the bridged store and the environment', async () => {
    const calls: unknown[][] = [];
    const host = setup({
      env: { PATH: '/mock' },
      createServer: async (...args) => {
        calls.push(args);
        return fakeServer();
      },
    });

    host.send({ type: 'start', config: config({ port: 41873 }) });
    await host.next('listening');

    expect(calls).toHaveLength(1);
    const [appConfig, overrides] = calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(appConfig).toMatchObject({ mode: 'desktop', port: 41873, staticToken: TOKEN });
    expect(overrides['env']).toEqual({ PATH: '/mock' });
    expect(overrides['secrets']).toBeDefined();
    expect(host.posted).toEqual([{ type: 'listening', port: 50123 }]);
  });

  test('a second start message is ignored', async () => {
    let created = 0;
    const host = setup({
      createServer: async () => {
        created += 1;
        return fakeServer();
      },
    });

    host.send({ type: 'start', config: config() });
    host.send({ type: 'start', config: config({ token: 'another-token-0123456789' }) });
    await host.next('listening');

    expect(created).toBe(1);
  });

  test('a port that is taken is reported as such', async () => {
    const host = setup({
      createServer: async () =>
        fakeServer({
          listen: async () => {
            throw Object.assign(new Error('listen EADDRINUSE 127.0.0.1:41873'), {
              code: 'EADDRINUSE',
            });
          },
        }),
    });

    host.send({ type: 'start', config: config({ port: 41873 }) });

    expect(await host.next('failed')).toEqual({ type: 'failed', reason: 'address_in_use' });
    expect(await host.exited()).toBe(1);
  });

  test('any other failure to start is reported without its message', async () => {
    const host = setup({
      createServer: async () => {
        throw new Error('cannot open /home/someone/data');
      },
    });

    host.send({ type: 'start', config: config() });

    expect(await host.next('failed')).toEqual({ type: 'failed', reason: 'error' });
    expect(await host.exited()).toBe(1);
    expect(JSON.stringify(host.logger.entries)).not.toContain('/home/someone');
  });

  test('a shutdown that takes too long kills the children and exits', async () => {
    const host = setup({
      createServer: async () => fakeServer({ shutdown: () => new Promise(() => undefined) }),
    });
    host.send({ type: 'start', config: config() });
    await host.next('listening');

    host.send({ type: 'shutdown' });
    host.send({ type: 'shutdown' });
    expect(host.exits).toEqual([]);
    const limits = host.timers.filter((timer) => timer.ms === SHUTDOWN_TIMEOUT_MS);
    expect(limits).toHaveLength(1);

    limits[0]?.task();

    expect(host.killed()).toBe(1);
    expect(host.exits).toEqual([1]);
  });

  test('a shutdown that fails kills the children and exits', async () => {
    const host = setup({
      createServer: async () =>
        fakeServer({
          shutdown: async () => {
            throw new Error('boom');
          },
        }),
    });
    host.send({ type: 'start', config: config() });
    await host.next('listening');

    host.send({ type: 'shutdown' });

    expect(await host.exited()).toBe(1);
    expect(host.killed()).toBe(1);
  });

  test('a shutdown before the start just exits', async () => {
    const host = setup();

    host.send({ type: 'shutdown' });

    expect(await host.exited()).toBe(0);
  });

  test('without a reaper the host still runs, and says so', async () => {
    const host = setup({ startReaper: () => undefined, createServer: async () => fakeServer() });

    host.send({ type: 'start', config: config() });
    await host.next('listening');

    expect(host.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  test('where the system ends the children, no reaper is started and nothing is amiss', async () => {
    let started = 0;
    const host = setup({
      startReaper: () => {
        started += 1;
        return undefined;
      },
      createServer: async () => fakeServer(),
    });

    host.send({ type: 'start', config: config({ reaper: undefined }) });
    await host.next('listening');

    expect(started).toBe(0);
    expect(host.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
  });

  test('messages of no known shape are ignored', () => {
    const host = setup();

    for (const message of [null, undefined, 'shutdown', 7, {}, { type: 'unknown' }]) {
      host.send(message);
    }

    expect(host.exits).toEqual([]);
    expect(host.posted).toEqual([]);
  });
});

describe('createBridgedSecretStore', () => {
  function bridge() {
    const posted: HostEvent[] = [];
    return { posted, ...createBridgedSecretStore({ postMessage: (m) => void posted.push(m) }) };
  }

  test('each call is one request, matched to its answer by id', async () => {
    const { posted, store, settle } = bridge();

    const first = store.get('a');
    const second = store.get('b');
    expect(posted).toEqual([
      { type: 'secret', id: 1, op: 'get', key: 'a' },
      { type: 'secret', id: 2, op: 'get', key: 'b' },
    ]);

    settle({ type: 'secret-result', id: 2, ok: true, value: 'two' });
    settle({ type: 'secret-result', id: 1, ok: true });

    expect(await first).toBeUndefined();
    expect(await second).toBe('two');
  });

  test('set and delete carry the key, and set the value', async () => {
    const { posted, store, settle } = bridge();

    const setting = store.set('a', 'one');
    const deleting = store.delete('a');
    settle({ type: 'secret-result', id: 1, ok: true });
    settle({ type: 'secret-result', id: 2, ok: true });
    await Promise.all([setting, deleting]);

    expect(posted).toEqual([
      { type: 'secret', id: 1, op: 'set', key: 'a', value: 'one' },
      { type: 'secret', id: 2, op: 'delete', key: 'a' },
    ]);
  });

  test('a store without encryption is an error the user is told about', async () => {
    const { store, settle } = bridge();

    const setting = store.set('a', 'sk-secret').catch((error: unknown) => error);
    settle({ type: 'secret-result', id: 1, ok: false, reason: 'unavailable' });
    const failure = await setting;

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('conflict');
    expect(String(failure)).not.toContain('sk-secret');
  });

  test('any other failure is an internal error', async () => {
    const { store, settle } = bridge();

    const getting = store.get('a').catch((error: unknown) => error);
    settle({ type: 'secret-result', id: 1, ok: false, reason: 'error' });
    const failure = await getting;

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AppError);
  });

  test('an answer nobody waits for is ignored', () => {
    const { settle } = bridge();

    expect(() => settle({ type: 'secret-result', id: 99, ok: true })).not.toThrow();
  });
});
