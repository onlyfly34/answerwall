/**
 * The service worker's rules, kept free of worker globals so they can be
 * tested: what it may answer from its cache, and what it must leave alone.
 */
import { BRAND } from '@answerwall/core/protocol';

export const SERVICE_WORKER_PATH = '/sw.js';
/** Sent by the page when it is about to reload into a newly installed worker. */
export const SKIP_WAITING_MESSAGE = 'skip-waiting';
export const SHELL_PATH = '/index.html';
export const CACHE_PREFIX = `${BRAND.slug}-static-`;

export interface PrecacheEntry {
  url: string;
  revision: string | null;
}

export type RouteDecision =
  /** Not handled: the browser talks to the network as if there were no worker. */
  | { kind: 'network' }
  /** A page navigation: answered with the cached app shell. */
  | { kind: 'shell' }
  /** A build asset: answered from the cache it was installed into. */
  | { kind: 'asset'; path: string };

export interface RoutedRequest {
  method: string;
  url: string;
  /** `Request.mode`; `navigate` for page loads. */
  mode: string;
}

/** Everything under `/api` is live data and credentials: never cached, never answered from cache. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

export function decideRoute(
  request: RoutedRequest,
  origin: string,
  precached: ReadonlySet<string>,
): RouteDecision {
  if (request.method !== 'GET') return { kind: 'network' };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: 'network' };
  }
  if (url.origin !== origin) return { kind: 'network' };
  if (isApiPath(url.pathname)) return { kind: 'network' };
  if (request.mode === 'navigate') {
    return precached.has(SHELL_PATH) ? { kind: 'shell' } : { kind: 'network' };
  }
  return precached.has(url.pathname) ? { kind: 'asset', path: url.pathname } : { kind: 'network' };
}

/** Paths the worker installs: the build's files, minus anything that is not a static asset. */
export function precachePaths(entries: readonly PrecacheEntry[], origin: string): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    const url = new URL(entry.url, `${origin}/`);
    if (url.origin === origin && !isApiPath(url.pathname)) paths.add(url.pathname);
  }
  return [...paths].sort();
}

/**
 * One cache per build: the name changes whenever any file or revision does,
 * so a new worker installs into a fresh cache and the old one is deleted
 * when it activates.
 */
export function cacheName(entries: readonly PrecacheEntry[]): string {
  let hash = 0x811c9dc5;
  const text = entries
    .map((entry) => `${entry.url}@${entry.revision ?? ''}`)
    .sort()
    .join('\n');
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return `${CACHE_PREFIX}${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Caches of earlier builds, to delete on activation. Other origins' apps are not ours to touch. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}
