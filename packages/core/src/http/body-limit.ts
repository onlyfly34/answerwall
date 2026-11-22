import { AppError } from '../contracts/index.ts';
import type { AppMiddleware, SettingsService } from '../contracts/index.ts';

const tooLarge = (): AppError => new AppError('payload_too_large', 'Request body is too large');

/**
 * Refuses request bodies above the configured size. A body with a declared
 * length is judged by that length. One without (chunked transfer, or no body
 * at all) is read here, counted as it arrives, and handed to the route
 * through the request's body cache.
 *
 * The request object is never replaced: constructing a `Request` from the
 * one the Node adapter hands out is not possible.
 */
export function createBodyLimit(settings: SettingsService): AppMiddleware {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    // The limit is a setting, so it is read for every request.
    const maxSize = settings.get().limits.maxRequestBodyBytes;

    const declared = c.req.header('Content-Length');
    if (declared !== undefined && c.req.header('Transfer-Encoding') === undefined) {
      if (Number.parseInt(declared, 10) > maxSize) throw tooLarge();
      return next();
    }

    const body = c.req.raw.body;
    if (!body) return next();
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    const whole = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      whole.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Every body reader of the request (`text()`, `json()`, …) is served from
    // this. The cache holds promises, whatever its declared type says.
    (c.req.bodyCache as Record<string, unknown>)['arrayBuffer'] = Promise.resolve(whole.buffer);
    return next();
  };
}
