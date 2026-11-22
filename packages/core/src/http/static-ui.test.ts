import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { API_PATHS } from '../protocol/index.ts';
import { TEST_TOKEN } from '../testing/index.ts';
import { toRelativePath } from './static-ui.ts';
import { createLayerHarness } from './testing.ts';
import type { LayerHarness } from './testing.ts';

const INDEX = '<!doctype html><title>app shell</title>';
const SCRIPT = 'console.log("bundle")';
const SECRET = 'outside the web root';

let directory: string;
let webRoot: string;
let harness: LayerHarness;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'static-ui-'));
  webRoot = join(directory, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await mkdir(join(webRoot, 'icons'));
  await mkdir(join(webRoot, 'api'));
  await writeFile(join(webRoot, 'index.html'), INDEX);
  await writeFile(join(webRoot, 'assets', 'index-BXy1Lom0.js'), SCRIPT);
  await writeFile(join(webRoot, 'assets', 'index-D_qRgNzx.css'), 'body{}');
  await writeFile(join(webRoot, 'sw.js'), 'self.skipWaiting()');
  await writeFile(join(webRoot, 'manifest.webmanifest'), '{}');
  await writeFile(join(webRoot, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(webRoot, 'api', 'meta'), 'a file that must never shadow the API');
  await writeFile(join(webRoot, '.env'), 'HIDDEN=1');
  await writeFile(join(directory, 'secret.txt'), SECRET);
  harness = createLayerHarness({ webRoot });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => harness.send(path, { headers });

describe('static UI', () => {
  test('the app shell is served at the root and revalidated on every use', async () => {
    const response = await get('/');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Length')).toBe(String(INDEX.length));
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  test('it needs no session', async () => {
    expect((await get('/')).status).toBe(200);
    expect((await get('/assets/index-BXy1Lom0.js')).status).toBe(200);
  });

  test('hashed assets are immutable', async () => {
    const script = await get('/assets/index-BXy1Lom0.js');
    expect(await script.text()).toBe(SCRIPT);
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

    const style = await get('/assets/index-D_qRgNzx.css');
    expect(style.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect(style.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  test.each([
    ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/index.html', 'text/html; charset=utf-8'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/icons/icon-192.png', 'image/png'],
  ])('%s is never cached without revalidation', async (path, contentType) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(contentType);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  });

  test.each(['/history', '/settings/providers', '/pair', '/history/', '/a/b/c/d'])(
    'the client-side route %s gets the app shell',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(INDEX);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    },
  );

  test.each(['/assets/missing-abc123.js', '/favicon.ico', '/assets/index-BXy1Lom0.js.map'])(
    'the missing file %s is a 404, not the app shell',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    },
  );

  test('a directory is not a file', async () => {
    const response = await get('/assets');
    expect(await response.text()).toBe(INDEX);
    expect((await get('/assets/')).headers.get('Cache-Control')).toBe('no-cache');
  });

  describe('the API is never served from files', () => {
    test('a file under api/ does not shadow a route', async () => {
      const response = await get(API_PATHS.meta);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(await response.json()).toHaveProperty('apiVersion');
    });

    test.each(['/api/unknown', '/api/unknown/deeper', '/api/assets/index-BXy1Lom0.js'])(
      'the unknown API path %s is a JSON 404 for a signed-in client',
      async (path) => {
        const response = await get(path, { Authorization: `Bearer ${TEST_TOKEN}` });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: { code: 'not_found', message: 'Not found' },
        });
      },
    );

    test('and a 401 for anybody else', async () => {
      expect((await get('/api/unknown')).status).toBe(401);
    });

    test('the bare /api path is not the app shell', async () => {
      const response = await get('/api');
      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    });
  });

  describe('path traversal', () => {
    test.each([
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..%5csecret.txt',
      '/assets%5c..%5c..%5csecret.txt',
      '/%252e%252e/secret.txt',
      '/secret.txt%00.html',
      '/C:%5cWindows%5cwin.ini',
      '/%c0%ae%c0%ae/secret.txt',
    ])('%s does not leave the web root', async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(SECRET);
    });

    test('dot files are not served', async () => {
      const response = await get('/.env');
      expect(await response.text()).not.toContain('HIDDEN');
      expect((await get('/assets/.hidden.js')).status).toBe(404);
    });

    test.skipIf(process.platform === 'win32')(
      'a symbolic link that points outside the root is not followed',
      async () => {
        await symlink(join(directory, 'secret.txt'), join(webRoot, 'assets', 'link.txt'));
        const response = await get('/assets/link.txt');
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(SECRET);
      },
    );
  });

  describe('toRelativePath', () => {
    test.each([
      ['/', ''],
      ['/index.html', 'index.html'],
      ['/assets/app.js', 'assets/app.js'],
      ['/history/', 'history'],
      ['/a%20b.txt', 'a b.txt'],
    ])('%s is %j', (path, relative) => {
      expect(toRelativePath(path)).toBe(relative);
    });

    test.each([
      '/../secret.txt',
      '/a/../../secret.txt',
      '/./index.html',
      '//etc/passwd',
      '/a//b',
      '/a\\b',
      '/%',
      '/.git/config',
      '/a/.b',
      '/c:/windows',
      '/file.txt:stream',
      '/a\0b',
    ])('%j is refused', (path) => {
      expect(toRelativePath(path)).toBeNull();
    });
  });

  describe('methods and validators', () => {
    test('HEAD answers with the headers and no body', async () => {
      const response = await harness.send('/assets/index-BXy1Lom0.js', { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Length')).toBe(String(SCRIPT.length));
      expect(await response.text()).toBe('');
    });

    test.each(['POST', 'PUT', 'DELETE'])('%s is not answered with a file', async (method) => {
      const response = await harness.send('/index.html', { method });
      expect(response.status).toBe(404);
    });

    test('an unchanged file is answered with 304 and a changed one in full', async () => {
      const first = await get('/sw.js');
      const etag = first.headers.get('ETag') ?? '';
      expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);

      const unchanged = await get('/sw.js', { 'If-None-Match': etag });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe('');
      expect(unchanged.headers.get('Cache-Control')).toBe('no-cache');

      await writeFile(join(webRoot, 'sw.js'), 'self.skipWaiting() // v2');
      await utimes(join(webRoot, 'sw.js'), new Date(), new Date(Date.now() + 5000));
      const changed = await get('/sw.js', { 'If-None-Match': etag });
      expect(changed.status).toBe(200);
      expect(await changed.text()).toContain('v2');
    });
  });

  test('a web root that does not exist serves nothing and works once it appears', async () => {
    const lateRoot = join(directory, 'late');
    const late = createLayerHarness({ webRoot: lateRoot });
    expect((await late.send('/')).status).toBe(404);
    expect((await late.send(API_PATHS.meta)).status).toBe(200);

    await mkdir(lateRoot);
    await writeFile(join(lateRoot, 'index.html'), INDEX);
    expect((await late.send('/')).status).toBe(200);
  });

  test('without a web root every page is a JSON 404 and the API still works', async () => {
    const apiOnly = createLayerHarness();
    expect((await apiOnly.send('/')).status).toBe(404);
    expect((await apiOnly.send(API_PATHS.meta)).status).toBe(200);
  });
});
