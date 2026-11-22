import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { AppMiddleware } from '../contracts/index.ts';

const INDEX_FILE = 'index.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** Must be revalidated on every use: the app shell, the service worker, the manifest, icons. */
const REVALIDATE = 'no-cache';
/** Safe to keep forever: the file name changes whenever the content does. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The bundler's output directory: every file in it carries a content hash in its name. */
const HASHED_ASSETS_DIR = 'assets/';

/**
 * Turns a request path into a path below the web root, or `null` when it
 * must not be served: undecodable, containing a NUL or a backslash, or with
 * a segment that is empty, `.`/`..`, or hidden (dot files).
 */
export function toRelativePath(requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((segment, index, all) => {
    // The leading slash and one trailing slash produce empty segments.
    return !(segment === '' && (index === 0 || index === all.length - 1));
  });
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
  // A drive or stream designator would escape the root on Windows.
  if (segments.some((segment) => segment.includes(':'))) return null;
  return segments.join('/');
}

interface FoundFile {
  path: string;
  stats: Stats;
}

/**
 * Serves the built web UI from `webRoot`.
 *
 * - Only GET and HEAD, never a path under `/api`.
 * - Files under `assets/` (content-hashed by the bundler) are immutable; everything else
 *   (`index.html`, the service worker, the manifest) is revalidated.
 * - A path without a file extension that matches no file is a client-side
 *   route and gets `index.html`; a missing file with an extension is a 404.
 * - Files are resolved through symbolic links and must stay inside the root.
 */
export function createStaticUi(webRoot: string): AppMiddleware {
  let resolvedRoot: Promise<string> | undefined;
  const root = (): Promise<string> => (resolvedRoot ??= realpath(webRoot));

  const find = async (relative: string): Promise<FoundFile | null> => {
    try {
      const base = await root();
      const path = await realpath(join(base, relative));
      if (path !== base && !path.startsWith(base + sep)) return null;
      const stats = await stat(path);
      return stats.isFile() ? { path, stats } : null;
    } catch {
      // Missing, unreadable, or a web root that does not exist (yet).
      resolvedRoot = undefined;
      return null;
    }
  };

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const requestPath = c.req.path;
    if (requestPath === '/api' || requestPath.startsWith('/api/')) return next();

    const relative = toRelativePath(requestPath);
    if (relative === null) return next();

    let served = relative;
    let file = relative === '' ? null : await find(relative);
    if (!file) {
      if (extname(relative) !== '') return next();
      served = INDEX_FILE;
      file = await find(INDEX_FILE);
      if (!file) return next();
    }

    const etag = `W/"${file.stats.size.toString(16)}-${Math.floor(file.stats.mtimeMs).toString(16)}"`;
    const headers = new Headers({
      'Content-Type': CONTENT_TYPES[extname(served).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': served.startsWith(HASHED_ASSETS_DIR) ? IMMUTABLE : REVALIDATE,
      ETag: etag,
    });
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers });
    }
    headers.set('Content-Length', String(file.stats.size));
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  };
}
