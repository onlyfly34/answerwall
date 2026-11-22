import { describe, expect, test } from 'vitest';
import { createMemoryLogger } from '@answerwall/core/testing';
import type { HostEvent, HostRequest } from '../shared/ipc.ts';
import {
  ALIVE_INTERVAL_MS,
  CoreStartError,
  START_TIMEOUT_MS,
  startCore,
  STOP_TIMEOUT_MS,
} from './core-process.ts';
import type { CoreProcessOptions, HostProcess } from './core-process.ts';
import { SecretsUnavailableError } from './secrets.ts';
import type { EncryptedSecretStore } from './secrets.ts';

const TOKEN = 'launch-token-0123456789abcdef0123456789';

function fakeChild() {
  const listeners: Record<string, ((value: never) => void)[]> = {};
  const sent: HostRequest[] = [];
  let killed = 0;
  const child: HostProcess = {
    postMessage: (message) => void sent.push(message),
    kill: () => {
      killed += 1;
      return true;
    },
    on(event: string, listener: (value: never) => void) {
      (listeners[event] ??= []).push(listener);
      return child;
    },
  };
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners[event] ?? []) listener(value as never);
  };
  return {
    child,
    sent,
    killed: () => killed,
    spawn: () => emit('spawn'),
    message: (message: HostEvent) => emit('message', message),
    exit: (code: number) => emit('exit', code),
  };
}

function setup(secrets: Partial<EncryptedSecretStore> = {}) {
  const fake = fakeChild();
  const timers: { ms: number; task: () => void; cancelled: boolean }[] = [];
  const memory = createMemoryLogger();
  const options: CoreProcessOptions = {
    fork: () => fake.child,
    config: {
      version: '1.2.3',
      dataDir: '/data',
      webRoot: '/web',
      logLevel: 'info',
      reaper: '/reaper.cjs',
    },
    generateToken: () => TOKEN,
    secrets: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      ...secrets,
    },
    logger: memory,
    schedule(ms, task) {
      const timer = { ms, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const fire = (ms: number): void => {
    for (const timer of timers.filter((entry) => entry.ms === ms && !entry.cancelled)) timer.task();
  };
  return { fake, options, timers, fire, memory };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('startCore', () => {
  test('hands the token over in the start message and nowhere else', async () => {
    const { fake, options, memory } = setup();
    const starting = startCore(options, 41873);

    expect(fake.sent).toEqual([]);
    fake.spawn();
    expect(fake.sent).toEqual([
      {
        type: 'start',
        config: {
          version: '1.2.3',
          dataDir: '/data',
          webRoot: '/web',
          logLevel: 'info',
          reaper: '/reaper.cjs',
          token: TOKEN,
          port: 41873,
        },
      },
    ]);

    fake.message({ type: 'listening', port: 41873 });
    const core = await starting;

    expect(core.grant).toEqual({ origin: 'http://127.0.0.1:41873', token: TOKEN });
    expect(core.port).toBe(41873);
    expect(JSON.stringify(memory.entries)).not.toContain(TOKEN);
  });

  test('the origin is the port the host reports, which the system may have chosen', async () => {
    const { fake, options } = setup();
    const starting = startCore(options, 0);
    fake.spawn();
    fake.message({ type: 'listening', port: 50123 });

    expect((await starting).grant.origin).toBe('http://127.0.0.1:50123');
  });

  test.each(['address_in_use', 'error'] as const)(
    'a host that reports %s fails the start',
    async (reason) => {
      const { fake, options } = setup();
      const starting = startCore(options, 41873);
      fake.spawn();
      fake.message({ type: 'failed', reason });
      fake.exit(1);

      const failure = await starting.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CoreStartError);
      expect((failure as CoreStartError).reason).toBe(reason);
    },
  );

  test('a host that exits before it listens fails the start', async () => {
    const { fake, options } = setup();
    const starting = startCore(options, 0);
    fake.exit(1);

    await expect(starting).rejects.toMatchObject({ reason: 'exited' });
  });

  test('a host that never answers is killed after the time limit', async () => {
    const { fake, options, fire } = setup();
    const starting = startCore(options, 0);
    fake.spawn();

    fire(START_TIMEOUT_MS);

    await expect(starting).rejects.toMatchObject({ reason: 'timeout' });
    expect(fake.killed()).toBe(1);
  });
});

describe('a running core', () => {
  async function running(secrets: Partial<EncryptedSecretStore> = {}) {
    const context = setup(secrets);
    const starting = startCore(context.options, 0);
    context.fake.spawn();
    context.fake.message({ type: 'listening', port: 50123 });
    const core = await starting;
    context.fake.sent.length = 0;
    return { ...context, core };
  }

  test('stop asks for a shutdown and waits for the exit', async () => {
    const { fake, core, timers } = await running();
    let stopped = false;
    const stopping = core.stop().then(() => {
      stopped = true;
    });

    await settled();
    expect(fake.sent).toEqual([{ type: 'shutdown' }]);
    expect(stopped).toBe(false);

    fake.exit(0);
    await stopping;
    expect(fake.killed()).toBe(0);
    expect(timers.find((timer) => timer.ms === STOP_TIMEOUT_MS)?.cancelled).toBe(true);
    expect(await core.exited).toBe(false);
  });

  test('keeps telling the host that the main process is alive, until the host has exited', async () => {
    const { fake, timers } = await running();
    /** The interval passes once more: its newest timer runs. */
    const pass = (): void => timers.findLast((timer) => timer.ms === ALIVE_INTERVAL_MS)?.task();

    pass();
    pass();
    pass();
    expect(fake.sent).toEqual([{ type: 'alive' }, { type: 'alive' }, { type: 'alive' }]);

    fake.exit(0);
    fake.sent.length = 0;
    expect(timers.findLast((timer) => timer.ms === ALIVE_INTERVAL_MS)?.cancelled).toBe(true);
    for (const timer of timers.filter((entry) => entry.ms === ALIVE_INTERVAL_MS)) timer.task();
    expect(fake.sent).toEqual([]);
  });

  test('a host that does not stop in time is killed', async () => {
    const { fake, core, fire } = await running();
    const stopping = core.stop();
    await settled();

    fire(STOP_TIMEOUT_MS);
    expect(fake.killed()).toBe(1);

    fake.exit(1);
    await stopping;
  });

  test('requestStop sends one shutdown and does not wait', async () => {
    const { fake, core } = await running();

    core.requestStop();
    core.requestStop();
    void core.stop();
    await settled();

    expect(fake.sent).toEqual([{ type: 'shutdown' }]);
  });

  test('an exit nobody asked for is reported as unexpected', async () => {
    const { fake, core } = await running();

    fake.exit(1);

    expect(await core.exited).toBe(true);
    await core.stop();
    core.requestStop();
    expect(fake.sent).toEqual([]);
  });

  test('answers the host’s secret store requests', async () => {
    const stored = new Map<string, string>([['a', 'one']]);
    const { fake } = await running({
      get: async (key) => stored.get(key),
      set: async (key, value) => void stored.set(key, value),
      delete: async (key) => void stored.delete(key),
    });

    fake.message({ type: 'secret', id: 1, op: 'get', key: 'a' });
    fake.message({ type: 'secret', id: 2, op: 'get', key: 'missing' });
    fake.message({ type: 'secret', id: 3, op: 'set', key: 'b', value: 'two' });
    fake.message({ type: 'secret', id: 4, op: 'delete', key: 'a' });
    await settled();

    expect(fake.sent).toEqual([
      { type: 'secret-result', id: 1, ok: true, value: 'one' },
      { type: 'secret-result', id: 2, ok: true },
      { type: 'secret-result', id: 3, ok: true },
      { type: 'secret-result', id: 4, ok: true },
    ]);
    expect([...stored]).toEqual([['b', 'two']]);
  });

  test('a failing secret store is answered without the value or the error text', async () => {
    const { fake, memory } = await running({
      set: async (_key, value) => {
        throw value === 'x' ? new SecretsUnavailableError() : new Error(`cannot write ${value}`);
      },
    });

    fake.message({ type: 'secret', id: 1, op: 'set', key: 'a', value: 'x' });
    fake.message({ type: 'secret', id: 2, op: 'set', key: 'a', value: 'sk-secret' });
    await settled();

    expect(fake.sent).toEqual([
      { type: 'secret-result', id: 1, ok: false, reason: 'unavailable' },
      { type: 'secret-result', id: 2, ok: false, reason: 'error' },
    ]);
    expect(JSON.stringify(memory.entries)).not.toContain('sk-secret');
  });

  test('an answer for a host that has exited is not sent', async () => {
    let release: () => void = () => undefined;
    const { fake } = await running({
      get: () =>
        new Promise((resolve) => {
          release = () => resolve('late');
        }),
    });

    fake.message({ type: 'secret', id: 1, op: 'get', key: 'a' });
    fake.exit(0);
    release();
    await settled();

    expect(fake.sent).toEqual([]);
  });
});
