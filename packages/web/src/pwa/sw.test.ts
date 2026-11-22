import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cacheName, CACHE_PREFIX, SKIP_WAITING_MESSAGE } from './routing.ts';
import type { PrecacheEntry } from './routing.ts';

const ORIGIN = 'https://wall.example';
const ENTRIES: PrecacheEntry[] = [
  { url: 'index.html', revision: 'r1' },
  { url: 'assets/index-abc.js', revision: null },
  // Must never be installed, whatever the build lists.
  { url: 'api/meta', revision: 'x' },
];

/** What the worker needs from a request; the real class refuses relative URLs outside a browser. */
class FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache: string | undefined;

  constructor(url: string, init: { method?: string; mode?: string; cache?: string } = {}) {
    this.url = new URL(url, ORIGIN).href;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
    this.cache = init.cache;
  }
}

class FakeCache {
  readonly stored = new Map<string, Response>();
  readonly installed: FakeRequest[] = [];

  async addAll(requests: FakeRequest[]): Promise<void> {
    for (const request of requests) {
      this.installed.push(request);
      this.stored.set(new URL(request.url).pathname, new Response(`cached ${request.url}`));
    }
  }

  async match(path: string): Promise<Response | undefined> {
    return this.stored.get(path)?.clone();
  }

  put = vi.fn();
  add = vi.fn();
}

type Listener = (event: never) => void;

async function loadWorker() {
  const caches = new Map<string, FakeCache>();
  const listeners = new Map<string, Listener>();
  const scope = {
    __WB_MANIFEST: ENTRIES,
    location: { origin: ORIGIN },
    caches: {
      open: async (name: string) => {
        if (!caches.has(name)) caches.set(name, new FakeCache());
        return caches.get(name);
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: Listener) => void listeners.set(type, listener),
  };
  const network = vi.fn(async (request: FakeRequest) => new Response(`network ${request.url}`));
  vi.stubGlobal('self', scope);
  vi.stubGlobal('Request', FakeRequest);
  vi.stubGlobal('fetch', network);
  vi.resetModules();
  await import('./sw.ts');

  async function lifecycle(type: 'install' | 'activate'): Promise<void> {
    let work: Promise<unknown> = Promise.resolve();
    (listeners.get(type) as (event: { waitUntil(p: Promise<unknown>): void }) => void)({
      waitUntil: (promise) => {
        work = promise;
      },
    });
    await work;
  }

  /** Dispatches a fetch event; resolves with the worker's answer, or `undefined` when it stays out. */
  async function request(
    path: string,
    init?: { method?: string; mode?: string },
  ): Promise<string | undefined> {
    let answer: Promise<Response> | undefined;
    (
      listeners.get('fetch') as (event: {
        request: FakeRequest;
        respondWith(response: Promise<Response>): void;
      }) => void
    )({
      request: new FakeRequest(path, init),
      respondWith: (response) => {
        answer = response;
      },
    });
    return answer ? (await answer).text() : undefined;
  }

  return { scope, caches, listeners, network, lifecycle, request };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the service worker', () => {
  test('install fills one cache with the build files, fresh from the network, and no API path', async () => {
    const worker = await loadWorker();
    await worker.lifecycle('install');

    const cache = worker.caches.get(cacheName(ENTRIES));
    expect([...(cache?.stored.keys() ?? [])].sort()).toEqual([
      '/assets/index-abc.js',
      '/index.html',
    ]);
    expect(cache?.installed.every((item) => item.cache === 'reload')).toBe(true);
  });

  test('requests to the API are never answered by the worker and never stored', async () => {
    const worker = await loadWorker();
    await worker.lifecycle('install');

    for (const path of ['/api/meta', '/api/settings', '/api/ask/a1/stream?after=3']) {
      expect(await worker.request(path)).toBeUndefined();
      expect(await worker.request(path, { mode: 'navigate' })).toBeUndefined();
    }
    expect(await worker.request('/api/ask', { method: 'POST' })).toBeUndefined();

    expect(worker.network).not.toHaveBeenCalled();
    for (const cache of worker.caches.values()) {
      expect(cache.put).not.toHaveBeenCalled();
      expect(cache.add).not.toHaveBeenCalled();
      expect([...cache.stored.keys()].some((path) => path.startsWith('/api'))).toBe(false);
    }
  });

  test('build files and page navigations are answered from the cache, offline included', async () => {
    const worker = await loadWorker();
    await worker.lifecycle('install');
    worker.network.mockRejectedValue(new TypeError('offline'));

    expect(await worker.request('/assets/index-abc.js')).toBe(
      `cached ${ORIGIN}/assets/index-abc.js`,
    );
    expect(await worker.request('/history', { mode: 'navigate' })).toBe(
      `cached ${ORIGIN}/index.html`,
    );
    expect(worker.network).not.toHaveBeenCalled();
  });

  test('a file missing from the cache is fetched, and still not stored', async () => {
    const worker = await loadWorker();
    await worker.lifecycle('install');
    worker.caches.get(cacheName(ENTRIES))?.stored.delete('/assets/index-abc.js');

    expect(await worker.request('/assets/index-abc.js')).toBe(
      `network ${ORIGIN}/assets/index-abc.js`,
    );
    expect(worker.caches.get(cacheName(ENTRIES))?.put).not.toHaveBeenCalled();
  });

  test('files that are not part of the build are left to the browser', async () => {
    const worker = await loadWorker();
    await worker.lifecycle('install');

    expect(await worker.request('/assets/unknown.js')).toBeUndefined();
    expect(await worker.request('/sw.js')).toBeUndefined();
  });

  test('activate deletes the caches of earlier builds and takes the open pages', async () => {
    const worker = await loadWorker();
    await worker.scope.caches.open(`${CACHE_PREFIX}0ld`);
    await worker.scope.caches.open('someone-else');
    await worker.lifecycle('install');

    await worker.lifecycle('activate');

    expect([...worker.caches.keys()].sort()).toEqual([cacheName(ENTRIES), 'someone-else'].sort());
    expect(worker.scope.clients.claim).toHaveBeenCalledTimes(1);
  });

  test('it takes over early only when the page asks', async () => {
    const worker = await loadWorker();
    const onMessage = worker.listeners.get('message') as (event: { data: unknown }) => void;

    onMessage({ data: 'something else' });
    expect(worker.scope.skipWaiting).not.toHaveBeenCalled();

    onMessage({ data: SKIP_WAITING_MESSAGE });
    expect(worker.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
