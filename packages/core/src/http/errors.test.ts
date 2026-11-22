import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';
import { AppError, HTTP_STATUS, NotImplementedError } from '../contracts/index.ts';
import type { AppEnv } from '../contracts/index.ts';
import { API_ERROR_CODES, ApiErrorBodySchema } from '../protocol/index.ts';
import { createMemoryLogger } from '../testing/index.ts';
import { createErrorHandlers } from './errors.ts';

function appThatThrows(error: unknown) {
  const logger = createMemoryLogger();
  const handlers = createErrorHandlers(logger);
  const app = new Hono<AppEnv>();
  app.onError(handlers.onError);
  app.notFound(handlers.notFound);
  app.get('/fail', () => {
    throw error;
  });
  return { app, logger };
}

describe('onError', () => {
  test.each(API_ERROR_CODES)(
    'an AppError "%s" keeps its code, message and status',
    async (code) => {
      const { app, logger } = appThatThrows(new AppError(code, 'Something the user can read'));

      const response = await app.request('/fail');

      expect(response.status).toBe(HTTP_STATUS[code]);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(ApiErrorBodySchema.parse(await response.json())).toEqual({
        error: { code, message: 'Something the user can read' },
      });
      expect(logger.entries).toEqual([]);
    },
  );

  test('a unit that is not built yet answers 501', async () => {
    const { app } = appThatThrows(new NotImplementedError('Storage.turns.get'));
    const response = await app.request('/fail');
    expect(response.status).toBe(501);
  });

  test('any other error becomes a generic 500 that leaks nothing', async () => {
    const error = new TypeError(
      "ENOENT: no such file or directory, open '/srv/data/secrets.json' token=abc123",
    );
    const { app, logger } = appThatThrows(error);

    const response = await app.request('/fail?token=in-the-query');

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    });
    for (const leak of [
      'ENOENT',
      '/srv/data',
      'secrets.json',
      'abc123',
      'TypeError',
      'at ',
      '.ts',
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(logger.entries).toEqual([
      { level: 'error', message: 'unhandled error', fields: { path: '/fail', error: 'TypeError' } },
    ]);
  });

  test('the cause of an AppError is not sent', async () => {
    const cause = new Error('database is locked: /var/lib/app/db.sqlite');
    const { app } = appThatThrows(new AppError('conflict', 'Try again', { cause }));

    const text = await (await app.request('/fail')).text();

    expect(JSON.parse(text)).toEqual({ error: { code: 'conflict', message: 'Try again' } });
  });

  test.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [413, 'payload_too_large'],
    [415, 'unsupported_media_type'],
    [418, 'bad_request'],
    [429, 'rate_limited'],
  ] as const)(
    'a framework error with status %i becomes "%s" with a fixed message',
    async (status, code) => {
      const { app } = appThatThrows(
        new HTTPException(status, { message: 'internal detail /etc/passwd' }),
      );

      const response = await app.request('/fail');

      expect(response.status).toBe(status);
      const body = ApiErrorBodySchema.parse(await response.json());
      expect(body.error.code).toBe(code);
      expect(body.error.message).not.toContain('internal detail');
    },
  );

  test('a framework error with a server status is a generic 500', async () => {
    const { app, logger } = appThatThrows(new HTTPException(503, { message: 'upstream detail' }));

    const response = await app.request('/fail');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    });
    expect(logger.entries).toHaveLength(1);
  });
});

describe('notFound', () => {
  test('is a JSON 404', async () => {
    const { app } = appThatThrows(new Error('unused'));
    const response = await app.request('/nowhere');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});
