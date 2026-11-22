import { describe, expect, test } from 'vitest';
import { API_PATHS, LIMIT_SPECS } from '../protocol/index.ts';
import { TEST_TOKEN } from '../testing/index.ts';
import { createLayerHarness } from './testing.ts';
import type { LayerHarness } from './testing.ts';

const bearerJson = { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' };

describe('bodyLimit', () => {
  const MIN = LIMIT_SPECS.maxRequestBodyBytes.min;

  async function withSmallLimit(): Promise<LayerHarness> {
    const harness = createLayerHarness();
    await harness.settings.update({
      limits: { maxRequestBodyBytes: MIN, maxPromptBytes: LIMIT_SPECS.maxPromptBytes.min },
    });
    return harness;
  }
  /** A JSON document of exactly `bytes` bytes. */
  const document = (bytes: number): string => JSON.stringify({ pad: 'x'.repeat(bytes - 10) });

  test('a body at the limit passes and one byte more is refused', async () => {
    const harness = await withSmallLimit();
    const send = (body: string) =>
      harness.send(API_PATHS.authLogout, { method: 'POST', headers: bearerJson, body });

    expect(document(MIN)).toHaveLength(MIN);
    expect((await send(document(MIN))).status).not.toBe(413);

    const response = await send(document(MIN + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'payload_too_large', message: 'Request body is too large' },
    });
  });

  test('a streamed body without a length is cut off at the limit', async () => {
    const harness = await withSmallLimit();
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 64) controller.enqueue(chunk);
        else controller.close();
      },
    });

    const streamed: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { ...bearerJson, Host: 'localhost' },
      body,
      duplex: 'half',
    };
    const response = await harness.app.request(
      new Request(`http://localhost${API_PATHS.authLogout}`, streamed),
      undefined,
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    );

    expect(response.status).toBe(413);
  });

  test('the limit follows the setting', async () => {
    const harness = createLayerHarness();
    const send = () =>
      harness.send(API_PATHS.authLogout, {
        method: 'POST',
        headers: bearerJson,
        body: document(MIN + 1),
      });

    expect((await send()).status).not.toBe(413);
    await harness.settings.update({
      limits: { maxRequestBodyBytes: MIN, maxPromptBytes: LIMIT_SPECS.maxPromptBytes.min },
    });
    expect((await send()).status).toBe(413);
  });

  test('an oversized body is refused before authentication looks at anything', async () => {
    const harness = await withSmallLimit();
    const response = await harness.send(API_PATHS.authPair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: document(MIN * 2),
    });
    expect(response.status).toBe(413);
  });
});

describe('requestLog', () => {
  const requests = (harness: LayerHarness) =>
    harness.logger.entries.filter((entry) => entry.message === 'request');

  test('logs method, path, status, duration and client, and nothing else', async () => {
    const harness = createLayerHarness();

    await harness.send(`${API_PATHS.history}?q=my+secret+question&token=abc`, {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Cookie: 'other=value',
        'User-Agent': 'curl/8',
      },
    });

    expect(requests(harness)).toEqual([
      {
        level: 'info',
        message: 'request',
        fields: {
          method: 'GET',
          path: API_PATHS.history,
          status: 200,
          durationMs: 0,
          client: '127.0.0.1',
        },
      },
    ]);
    const logged = JSON.stringify(harness.logger.entries);
    for (const secret of [TEST_TOKEN, 'secret', 'abc', 'curl', 'other=value']) {
      expect(logged).not.toContain(secret);
    }
  });

  test('rejections by the guards are logged with their status', async () => {
    const harness = createLayerHarness();
    await harness.send(API_PATHS.meta, { headers: { Host: 'evil.example' } });
    await harness.send(API_PATHS.providers);

    expect(requests(harness).map((entry) => entry.fields.status)).toEqual([403, 401]);
  });

  test('the logged client is the forwarded address only behind a trusted proxy', async () => {
    const harness = createLayerHarness({ trustedProxies: ['10.0.0.2'] });
    const headers = { 'X-Forwarded-For': '203.0.113.7' };
    await harness.send(API_PATHS.meta, { peer: '10.0.0.2', headers });
    await harness.send(API_PATHS.meta, { peer: '127.0.0.1', headers });

    expect(requests(harness).map((entry) => entry.fields.client)).toEqual([
      '203.0.113.7',
      '127.0.0.1',
    ]);
  });

  test('pages are logged at debug level', async () => {
    const harness = createLayerHarness();
    await harness.send('/some/page');
    expect(requests(harness).map((entry) => entry.level)).toEqual(['debug']);
  });
});

describe('createHttpLayer', () => {
  test('serves no UI without a web root', () => {
    expect(createLayerHarness().http.staticUi).toBeUndefined();
    expect(createLayerHarness({ webRoot: 'somewhere' }).http.staticUi).toBeDefined();
  });

  test('a malformed trusted proxy entry is a configuration error naming the entry', () => {
    expect(() => createLayerHarness({ trustedProxies: ['10.0.0.0/8', 'proxy.internal'] })).toThrow(
      'Not an IP address or CIDR range: "proxy.internal"',
    );
  });
});
