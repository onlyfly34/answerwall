import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { brokenStorage, memoryStorage } from '../infra/test-support.ts';
import { SKIP_WAITING_MESSAGE } from './routing.ts';
import { createUpdater, UPDATE_ATTEMPT_KEY, UPDATE_TIMEOUT_MS } from './updater.ts';
import type { UpdaterEnvironment } from './updater.ts';

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];

  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  become(state: ServiceWorkerState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

function fakeContainer(registration?: {
  installing?: FakeWorker;
  waiting?: FakeWorker;
  update?: () => Promise<void>;
}) {
  const target = new EventTarget();
  const update = vi.fn(registration?.update ?? (async () => undefined));
  const container = {
    getRegistration: vi.fn(async () =>
      registration
        ? {
            installing: registration.installing ?? null,
            waiting: registration.waiting ?? null,
            update,
          }
        : undefined,
    ),
    addEventListener: target.addEventListener.bind(target),
  } as unknown as NonNullable<UpdaterEnvironment['serviceWorker']>;
  return {
    container,
    update,
    takeControl: () => target.dispatchEvent(new Event('controllerchange')),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('without a service worker', () => {
  test('a stale shell reloads once per server version, so a mismatch cannot loop', async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const updater = createUpdater({ storage, reload });

    expect(await updater.apply('2.0.0/1')).toBe(true);
    expect(await updater.apply('2.0.0/1')).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.values.get(UPDATE_ATTEMPT_KEY)).toBe('2.0.0/1');

    expect(await updater.apply('2.1.0/1')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test('the user can always force a reload', async () => {
    const reload = vi.fn();
    const updater = createUpdater({ storage: memoryStorage(), reload });
    await updater.apply('2.0.0/1');

    expect(await updater.apply('2.0.0/1', true)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test('a current shell forgets earlier attempts', async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const updater = createUpdater({ storage, reload });
    await updater.apply('2.0.0/1');

    updater.settled();

    expect(storage.values.has(UPDATE_ATTEMPT_KEY)).toBe(false);
    expect(await updater.apply('2.0.0/1')).toBe(true);
  });

  test.each([
    ['missing', undefined],
    ['blocked', brokenStorage],
  ])('with %s storage it never reloads by itself, only when asked', async (_name, storage) => {
    const reload = vi.fn();
    const updater = createUpdater({ storage, reload });

    expect(await updater.apply('2.0.0/1')).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(() => updater.settled()).not.toThrow();

    expect(await updater.apply('2.0.0/1', true)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('with a service worker', () => {
  test('a waiting worker is told to take over, and the page reloads once it controls it', async () => {
    const waiting = new FakeWorker('installed');
    const sw = fakeContainer({ waiting });
    const reload = vi.fn();
    const updater = createUpdater({
      serviceWorker: sw.container,
      storage: memoryStorage(),
      reload,
    });

    const applied = updater.apply('2.0.0/1');
    await vi.advanceTimersByTimeAsync(0);

    expect(sw.update).toHaveBeenCalledTimes(1);
    expect(waiting.messages).toEqual([SKIP_WAITING_MESSAGE]);
    expect(reload).not.toHaveBeenCalled();

    sw.takeControl();
    expect(await applied).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a worker that is still installing is waited for', async () => {
    const installing = new FakeWorker('installing');
    const sw = fakeContainer({ installing });
    const reload = vi.fn();
    const updater = createUpdater({
      serviceWorker: sw.container,
      storage: memoryStorage(),
      reload,
    });

    const applied = updater.apply('2.0.0/1');
    await vi.advanceTimersByTimeAsync(0);
    expect(installing.messages).toEqual([]);

    installing.become('installed');
    await vi.advanceTimersByTimeAsync(0);
    expect(installing.messages).toEqual([SKIP_WAITING_MESSAGE]);

    sw.takeControl();
    await applied;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['nothing changed', fakeContainer({})],
    ['there is no registration', fakeContainer()],
    [
      'the server cannot be reached',
      fakeContainer({
        update: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ],
  ])('when %s the page simply reloads', async (_name, sw) => {
    const reload = vi.fn();
    const updater = createUpdater({
      serviceWorker: sw.container,
      storage: memoryStorage(),
      reload,
    });

    expect(await updater.apply('2.0.0/1')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a worker that fails to install does not block the reload', async () => {
    const installing = new FakeWorker('installing');
    const sw = fakeContainer({ installing });
    const reload = vi.fn();
    const updater = createUpdater({
      serviceWorker: sw.container,
      storage: memoryStorage(),
      reload,
    });

    const applied = updater.apply('2.0.0/1');
    await vi.advanceTimersByTimeAsync(0);
    installing.become('redundant');

    expect(await applied).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a worker that never takes over is not waited for beyond the timeout', async () => {
    const waiting = new FakeWorker('installed');
    const sw = fakeContainer({ waiting });
    const reload = vi.fn();
    const updater = createUpdater({
      serviceWorker: sw.container,
      storage: memoryStorage(),
      reload,
    });

    const applied = updater.apply('2.0.0/1');
    await vi.advanceTimersByTimeAsync(UPDATE_TIMEOUT_MS - 1);
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await applied).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
