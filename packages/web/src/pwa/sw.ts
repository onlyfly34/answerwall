/**
 * The service worker. It serves the app shell and the build's static files
 * from a cache filled at install time, so the app opens without a network.
 * It never caches at runtime and never touches `/api/` (see routing.ts).
 */
import {
  cacheName,
  decideRoute,
  precachePaths,
  SHELL_PATH,
  SKIP_WAITING_MESSAGE,
  staleCaches,
} from './routing.ts';
import type { PrecacheEntry } from './routing.ts';

/** The parts of `ServiceWorkerGlobalScope` used here; the DOM typings do not include it. */
interface ExtendableEvent {
  waitUntil(work: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  /** Replaced with the list of build files when the worker is built. */
  __WB_MANIFEST: PrecacheEntry[];
  location: { origin: string };
  caches: CacheStorage;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** The worker's global scope. The build finds the literal `self.__WB_MANIFEST` below and replaces it. */
declare const self: WorkerScope;
const worker = self;
const entries = self.__WB_MANIFEST;
const origin = worker.location.origin;
const paths = precachePaths(entries, origin);
const precached = new Set(paths);
const currentCache = cacheName(entries);

async function install(): Promise<void> {
  const cache = await worker.caches.open(currentCache);
  // `reload` bypasses the HTTP cache: the files must be the ones of this build.
  await cache.addAll(paths.map((path) => new Request(path, { cache: 'reload' })));
}

async function activate(): Promise<void> {
  const names = await worker.caches.keys();
  await Promise.all(staleCaches(names, currentCache).map((name) => worker.caches.delete(name)));
  await worker.clients.claim();
}

async function fromCache(path: string, request: Request): Promise<Response> {
  const cache = await worker.caches.open(currentCache);
  return (await cache.match(path)) ?? fetch(request);
}

/** A navigation may not be answered with a response that was redirected when it was cached. */
async function shell(request: Request): Promise<Response> {
  const cached = await fromCache(SHELL_PATH, request);
  if (!cached.redirected) return cached;
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

worker.addEventListener('install', (event) => event.waitUntil(install()));
worker.addEventListener('activate', (event) => event.waitUntil(activate()));

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  const decision = decideRoute(request, origin, precached);
  if (decision.kind === 'shell') event.respondWith(shell(request));
  else if (decision.kind === 'asset') event.respondWith(fromCache(decision.path, request));
});

worker.addEventListener('message', (event) => {
  if (event.data === SKIP_WAITING_MESSAGE) void worker.skipWaiting();
});
