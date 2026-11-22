import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, test } from 'vitest';
import { API_PATHS, LIMIT_SPECS } from '../protocol/index.ts';
import { TEST_TOKEN } from '../testing/index.ts';
import { createLayerHarness } from './testing.ts';
import type { LayerHarness } from './testing.ts';

/**
 * These run over a real socket through the listener `server.ts` uses: the
 * request object a handler sees there is not a native `Request`, which
 * `app.request()` cannot reproduce.
 */
describe('bodyLimit over a socket', () => {
  const MIN = LIMIT_SPECS.maxRequestBodyBytes.min;
  let server: Server | undefined;

  afterEach(async () => {
    const bound = server;
    server = undefined;
    bound?.closeAllConnections();
    if (bound) await new Promise((resolve) => bound.close(resolve));
  });

  async function listen(harness: LayerHarness): Promise<number> {
    const handle = getRequestListener(harness.app.fetch, { overrideGlobalObjects: false });
    const bound = createServer((request, response) => void handle(request, response));
    server = bound;
    await new Promise<void>((resolve) => bound.listen(0, '127.0.0.1', resolve));
    return (bound.address() as AddressInfo).port;
  }

  interface Sent {
    method: string;
    path: string;
    headers?: Record<string, string>;
    /** Written piece by piece without a length, so the request is chunked. */
    chunks?: string[];
  }

  function send(port: number, sent: Sent): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: sent.method,
          path: sent.path,
          headers: {
            Host: 'localhost',
            Authorization: `Bearer ${TEST_TOKEN}`,
            'Content-Type': 'application/json',
            ...sent.headers,
          },
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (piece: string) => (text += piece));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown }),
          );
        },
      );
      outgoing.on('error', reject);
      for (const chunk of sent.chunks ?? []) outgoing.write(chunk);
      outgoing.end();
    });
  }

  const unhandled = (harness: LayerHarness) =>
    harness.logger.entries.filter((entry) => entry.message === 'unhandled error');

  test('a DELETE without a body reaches its route', async () => {
    const harness = createLayerHarness();
    const port = await listen(harness);

    const response = await send(port, { method: 'DELETE', path: API_PATHS.authDevice('nope') });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'not_found', message: 'No such device' } });
    expect(unhandled(harness)).toEqual([]);
  });

  test('a POST without a body counts as an empty document', async () => {
    const harness = createLayerHarness();
    const port = await listen(harness);

    const response = await send(port, { method: 'POST', path: API_PATHS.authLogout });

    expect(response).toEqual({ status: 200, body: { ok: true } });
  });

  test('a chunked body is read like one with a length', async () => {
    const harness = createLayerHarness();
    const port = await listen(harness);
    const document = JSON.stringify({ code: '00000000', deviceName: 'laptop' });

    const response = await send(port, {
      method: 'POST',
      path: API_PATHS.authPair,
      headers: { Origin: 'http://localhost', Authorization: '' },
      chunks: [document.slice(0, 7), document.slice(7)],
    });

    expect(response.status).not.toBe(500);
    expect(response.status).not.toBe(400);
    expect(unhandled(harness)).toEqual([]);
  });

  test('a chunked request without a credential is refused as unauthorized', async () => {
    const harness = createLayerHarness();
    const port = await listen(harness);

    const response = await send(port, {
      method: 'PUT',
      path: API_PATHS.settings,
      headers: { Origin: 'http://localhost', Authorization: '' },
      chunks: ['{}'],
    });

    expect(response.status).toBe(401);
  });

  test('a chunked body is cut off at the limit', async () => {
    const harness = createLayerHarness();
    await harness.settings.update({
      limits: { maxRequestBodyBytes: MIN, maxPromptBytes: LIMIT_SPECS.maxPromptBytes.min },
    });
    const port = await listen(harness);
    const piece = 'x'.repeat(1024);
    const pieces = (bytes: number) => Array.from({ length: bytes / 1024 }, () => piece);
    const post = (chunks: string[]) =>
      send(port, { method: 'POST', path: API_PATHS.authLogout, chunks });

    // At the limit the body is read in full and found not to be JSON.
    expect((await post(pieces(MIN))).status).toBe(400);
    const response = await post([...pieces(MIN), 'x']);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'payload_too_large', message: 'Request body is too large' },
    });
  });

  test('a declared length above the limit is refused without reading the body', async () => {
    const harness = createLayerHarness();
    await harness.settings.update({
      limits: { maxRequestBodyBytes: MIN, maxPromptBytes: LIMIT_SPECS.maxPromptBytes.min },
    });
    const port = await listen(harness);

    const response = await send(port, {
      method: 'POST',
      path: API_PATHS.authLogout,
      headers: { 'Content-Length': String(MIN + 1) },
    });

    expect(response.status).toBe(413);
  });
});
