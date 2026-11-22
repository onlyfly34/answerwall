import { describe, expect, test } from 'vitest';
import { API_PATHS } from '@answerwall/core/protocol';
import {
  cacheName,
  CACHE_PREFIX,
  decideRoute,
  isApiPath,
  precachePaths,
  SHELL_PATH,
  staleCaches,
} from './routing.ts';
import type { PrecacheEntry, RoutedRequest } from './routing.ts';

const ORIGIN = 'https://wall.example';
const ENTRIES: PrecacheEntry[] = [
  { url: 'index.html', revision: 'r1' },
  { url: 'assets/index-abc.js', revision: null },
  { url: 'assets/index-abc.css', revision: null },
  { url: 'icon.svg', revision: 'r2' },
  { url: 'manifest.webmanifest', revision: 'r3' },
];
const PRECACHED = new Set(precachePaths(ENTRIES, ORIGIN));

const get = (path: string, mode = 'cors'): RoutedRequest => ({
  method: 'GET',
  url: new URL(path, ORIGIN).href,
  mode,
});

/** Every path of the protocol, with representative arguments. */
const API_URLS = Object.values(API_PATHS).map((path) =>
  typeof path === 'function' ? path('some-id', 3) : path,
);

describe('the API is never served or cached by the worker', () => {
  test.each(API_URLS)('GET %s goes to the network', (path) => {
    expect(decideRoute(get(path), ORIGIN, PRECACHED)).toEqual({ kind: 'network' });
  });

  test.each(API_URLS)('a navigation to %s goes to the network too', (path) => {
    expect(decideRoute(get(path, 'navigate'), ORIGIN, PRECACHED)).toEqual({ kind: 'network' });
  });

  test('that holds even if an API path were listed as precached', () => {
    const poisoned = new Set([...PRECACHED, '/api/meta', '/api/settings']);
    expect(decideRoute(get('/api/meta'), ORIGIN, poisoned)).toEqual({ kind: 'network' });
    expect(decideRoute(get('/api/settings?x=1'), ORIGIN, poisoned)).toEqual({ kind: 'network' });
  });

  test('API paths are dropped from the list of files to install', () => {
    const paths = precachePaths(
      [...ENTRIES, { url: 'api/meta', revision: 'x' }, { url: '/api/settings', revision: 'x' }],
      ORIGIN,
    );
    expect(paths.some(isApiPath)).toBe(false);
    expect(paths).toContain('/index.html');
  });

  test('the prefix is matched as a path segment', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/')).toBe(true);
    expect(isApiPath('/api/ask/x/stream')).toBe(true);
    expect(isApiPath('/apiary.js')).toBe(false);
    expect(isApiPath('/assets/api/x.js')).toBe(false);
  });
});

describe('static assets', () => {
  test('a precached build file is answered from the cache', () => {
    expect(decideRoute(get('/assets/index-abc.js'), ORIGIN, PRECACHED)).toEqual({
      kind: 'asset',
      path: '/assets/index-abc.js',
    });
    expect(decideRoute(get('/icon.svg?v=2', 'no-cors'), ORIGIN, PRECACHED)).toEqual({
      kind: 'asset',
      path: '/icon.svg',
    });
  });

  test('a file that was not installed is never cached at run time', () => {
    expect(decideRoute(get('/assets/other.js'), ORIGIN, PRECACHED)).toEqual({ kind: 'network' });
    expect(decideRoute(get('/sw.js'), ORIGIN, PRECACHED)).toEqual({ kind: 'network' });
  });

  test('page navigations get the app shell, whatever the client-side route', () => {
    for (const path of ['/', '/history', '/settings', '/sign-in', '/anything/else']) {
      expect(decideRoute(get(path, 'navigate'), ORIGIN, PRECACHED)).toEqual({ kind: 'shell' });
    }
  });

  test('without an installed shell navigations go to the network', () => {
    expect(decideRoute(get('/', 'navigate'), ORIGIN, new Set())).toEqual({ kind: 'network' });
  });

  test('writes, other origins and unparsable URLs are left alone', () => {
    expect(
      decideRoute({ ...get('/assets/index-abc.js'), method: 'POST' }, ORIGIN, PRECACHED),
    ).toEqual({ kind: 'network' });
    expect(
      decideRoute(
        { method: 'GET', url: 'https://elsewhere.example/assets/index-abc.js', mode: 'cors' },
        ORIGIN,
        PRECACHED,
      ),
    ).toEqual({ kind: 'network' });
    expect(
      decideRoute({ method: 'GET', url: 'not a url', mode: 'cors' }, ORIGIN, PRECACHED),
    ).toEqual({ kind: 'network' });
  });
});

describe('installing', () => {
  test('the list holds each same-origin file once, as an absolute path', () => {
    const paths = precachePaths(
      [...ENTRIES, ...ENTRIES, { url: 'https://cdn.example/lib.js', revision: null }],
      ORIGIN,
    );
    expect(paths).toEqual([
      '/assets/index-abc.css',
      '/assets/index-abc.js',
      '/icon.svg',
      SHELL_PATH,
      '/manifest.webmanifest',
    ]);
  });

  test('the cache name follows the content of the build and nothing else', () => {
    const name = cacheName(ENTRIES);
    expect(name.startsWith(CACHE_PREFIX)).toBe(true);
    expect(cacheName([...ENTRIES].reverse())).toBe(name);
    expect(cacheName([{ url: 'index.html', revision: 'r9' }, ...ENTRIES.slice(1)])).not.toBe(name);
    expect(cacheName([...ENTRIES, { url: 'assets/new.js', revision: null }])).not.toBe(name);
  });

  test('activation deletes the caches of earlier builds and no one else’s', () => {
    const current = cacheName(ENTRIES);
    expect(
      staleCaches([current, `${CACHE_PREFIX}00000000`, 'another-app-v1', 'workbox-x'], current),
    ).toEqual([`${CACHE_PREFIX}00000000`]);
  });
});
