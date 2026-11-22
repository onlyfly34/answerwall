import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SECRET_KEYS } from '../contracts/index.ts';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../contracts/index.ts';
import type { OpenAiCompatInstance } from '../protocol/index.ts';
import { systemClock } from '../system.ts';
import { createFakeSecretStore, createMemoryLogger, FakeClock } from '../testing/index.ts';
import {
  createOpenAiCompatAdapter,
  failureFromHttp,
  normalizeBaseUrl,
  parseModelsResponse,
} from './openai-compat.ts';
import { answerOf, collect, reasoningOf, typesOf, until } from './test-harness.ts';

describe('normalizeBaseUrl', () => {
  test.each([
    ['http://localhost:11434', 'http://localhost:11434/v1'],
    ['http://localhost:11434/', 'http://localhost:11434/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://localhost:11434/v1/', 'http://localhost:11434/v1'],
    ['http://localhost:11434/v1///', 'http://localhost:11434/v1'],
    ['  https://api.example.com/v1  ', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1'],
    ['https://api.example.com/v1/models/', 'https://api.example.com/v1'],
    ['https://api.example.com/openai', 'https://api.example.com/openai/v1'],
    ['https://api.example.com/openai/v1', 'https://api.example.com/openai/v1'],
    ['https://example.com/api/v3', 'https://example.com/api/v3'],
    ['https://example.com/v1beta/openai', 'https://example.com/v1beta/openai'],
    ['https://example.com/v1?key=secret#frag', 'https://example.com/v1'],
    ['https://user:pass@example.com/v1', 'https://example.com/v1'],
    ['HTTPS://EXAMPLE.com:443/V1', 'https://example.com/V1'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  test('throws for something that is not a URL', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow();
  });
});

describe('failureFromHttp', () => {
  test.each([
    [401, '{"error":{"message":"Incorrect API key provided"}}', 'not_logged_in'],
    [403, '{"error":{"message":"Forbidden"}}', 'not_logged_in'],
    [402, '', 'quota'],
    [
      404,
      '{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}',
      'model_not_found',
    ],
    [404, '{"detail":"Not Found"}', 'unsupported'],
    [404, '<html>404</html>', 'unsupported'],
    [413, '', 'prompt_too_long'],
    [429, '{"error":{"message":"Rate limit reached for requests"}}', 'rate_limited'],
    [
      429,
      '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
      'quota',
    ],
    [
      400,
      '{"error":{"message":"maximum context length is 4096 tokens","code":"context_length_exceeded"}}',
      'prompt_too_long',
    ],
    [400, '{"error":{"message":"model `x` not found"}}', 'model_not_found'],
    [400, '{"error":{"message":"bad request"}}', 'unknown'],
    [500, '{"error":"internal"}', 'unknown'],
    [502, '<html>Bad Gateway</html>', 'network'],
    [503, '', 'network'],
    [504, 'upstream timed out', 'network'],
  ] as const)('HTTP %d with %j is %s', (status, body, code) => {
    expect(failureFromHttp(status, body).code).toBe(code);
  });

  test('quotes the JSON error detail and nothing of a non-JSON body', () => {
    expect(
      failureFromHttp(429, '{"error":{"message":"Slow down","type":"rate_limit_error"}}').message,
    ).toBe('HTTP 429: rate_limit_error Slow down');
    expect(failureFromHttp(502, '<html><body>nginx at /var/www/secret</body></html>').message).toBe(
      'The endpoint answered HTTP 502.',
    );
    expect(failureFromHttp(500, '').message).toBe('The endpoint answered HTTP 500.');
  });

  test('never repeats the API key, even when the endpoint echoes it', () => {
    const key = 'my-short-key';
    const failure = failureFromHttp(
      401,
      JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.` } }),
      key,
    );

    expect(failure.message).not.toContain(key);
    expect(failure.message).toContain('<redacted>');
  });
});

describe('parseModelsResponse', () => {
  test('reads the standard list and leaves out models that are not chat models', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'chat-large', object: 'model' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' },
        { id: 'tts-1-hd' },
        { id: 'dall-e-3' },
        { id: 'omni-moderation-latest' },
        { id: 'vendor/rerank-v2' },
        { id: 'chat-small' },
        { id: 'chat-large' },
      ],
    };

    expect(parseModelsResponse(body)).toEqual([{ id: 'chat-large' }, { id: 'chat-small' }]);
  });

  test('uses type, mode or capability hints when the endpoint gives them', () => {
    const body = {
      data: [
        { id: 'a', type: 'embedding' },
        { id: 'b', mode: 'image_generation' },
        { id: 'c', capabilities: { completion_chat: false } },
        { id: 'd', type: 'chat' },
        { id: 'e', capabilities: { completion_chat: true } },
      ],
    };

    expect(parseModelsResponse(body)).toEqual([{ id: 'd' }, { id: 'e' }]);
  });

  test.each([
    [['m-1', 'm-2']],
    [{ models: [{ name: 'm-1' }, { model: 'm-2' }] }],
    [[{ id: ' m-1 ' }, null, 7, {}, { id: '' }, { id: 'm-2' }, { id: 'x'.repeat(201) }]],
  ])('tolerates the shape %j', (body) => {
    expect(parseModelsResponse(body)).toEqual([{ id: 'm-1' }, { id: 'm-2' }]);
  });

  test.each([undefined, null, 'text', 42, {}, { data: 'none' }, { object: 'error' }])(
    'returns nothing for %j',
    (body) => {
      expect(parseModelsResponse(body)).toEqual([]);
    },
  );

  test('bounds the number of models', () => {
    const data = Array.from({ length: 2000 }, (_, i) => ({ id: `m-${i}` }));

    expect(parseModelsResponse({ data })).toHaveLength(500);
  });
});

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | undefined;
}

type Handler = (request: Recorded, response: ServerResponse, raw: IncomingMessage) => void;

/** An in-process endpoint whose behaviour each test scripts. */
class Endpoint {
  readonly requests: Recorded[] = [];
  handler: Handler = (_request, response) => response.writeHead(500).end();
  private readonly server: Server;

  constructor() {
    this.server = createServer((raw, response) => {
      const chunks: Buffer[] = [];
      raw.on('data', (chunk: Buffer) => chunks.push(chunk));
      raw.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const recorded: Recorded = {
          method: raw.method ?? '',
          url: raw.url ?? '',
          headers: raw.headers,
          body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
        };
        this.requests.push(recorded);
        this.handler(recorded, response, raw);
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const FINISH = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

const sse =
  (...parts: string[]): Handler =>
  (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(parts.join(''));
  };
const json =
  (status: number, body: unknown): Handler =>
  (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

describe('the openai-compat adapter', () => {
  const KEY = 'sk-test-0123456789';
  let endpoint: Endpoint;
  let origin: string;
  let logger: ReturnType<typeof createMemoryLogger>;
  let shutdown: AbortController;
  let adapter: ProviderAdapter;

  const instance = (overrides: Partial<OpenAiCompatInstance> = {}): OpenAiCompatInstance => ({
    id: 'local',
    kind: 'openai-compat',
    label: 'Local',
    enabled: true,
    concurrency: 4,
    models: [],
    baseUrl: origin,
    hasApiKey: true,
    ...overrides,
  });
  const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
    prompt: 'What is 2 + 2?',
    model: 'chat-large',
    timeoutMs: 300_000,
    signal: new AbortController().signal,
    workDir: 'unused',
    ...overrides,
  });
  const run = (overrides: Partial<RunRequest> = {}, inst = instance()): Promise<ProviderEvent[]> =>
    collect(adapter.run(inst, request(overrides)));
  const build = (secrets: Record<string, string>, clock = systemClock) =>
    createOpenAiCompatAdapter({
      secrets: createFakeSecretStore(secrets),
      clock,
      logger,
      shutdownSignal: shutdown.signal,
    });

  beforeEach(async () => {
    endpoint = new Endpoint();
    origin = await endpoint.start();
    logger = createMemoryLogger();
    shutdown = new AbortController();
    adapter = build({ [SECRET_KEYS.providerApiKey('local')]: KEY });
  });
  afterEach(() => endpoint.stop());

  test('has no tools and no login command', () => {
    expect(adapter).toMatchObject({ kind: 'openai-compat', toolAccess: 'none' });
    expect(adapter.loginCommand).toBeUndefined();
  });

  describe('run', () => {
    test('posts a streaming chat completion and maps content, reasoning and usage', async () => {
      endpoint.handler = sse(
        chunk({ role: 'assistant', content: '' }),
        chunk({ reasoning_content: 'Let me think. ' }),
        chunk({ reasoning: 'Still thinking.' }),
        chunk({ content: 'Four' }),
        chunk({ content: '.' }),
        FINISH,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`,
        DONE,
      );

      const events = await run({ effort: 'high' });

      expect(events).toEqual([
        { type: 'start', streaming: 'token' },
        { type: 'reasoning', text: 'Let me think. ' },
        { type: 'reasoning', text: 'Still thinking.' },
        { type: 'delta', text: 'Four' },
        { type: 'delta', text: '.' },
        {
          type: 'done',
          elapsedMs: expect.any(Number) as number,
          usage: { inputTokens: 11, outputTokens: 5, reasoningTokens: 3 },
        },
      ]);
      expect(endpoint.requests).toHaveLength(1);
      const [sent] = endpoint.requests;
      expect(sent).toMatchObject({ method: 'POST', url: '/v1/chat/completions' });
      expect(sent?.headers['content-type']).toBe('application/json');
      expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(sent?.body).toEqual({
        model: 'chat-large',
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: 'high',
      });
    });

    test.each([
      ['', '/v1/chat/completions'],
      ['/', '/v1/chat/completions'],
      ['/v1', '/v1/chat/completions'],
      ['/v1/', '/v1/chat/completions'],
      ['/proxy/openai', '/proxy/openai/v1/chat/completions'],
      ['/proxy/v2/', '/proxy/v2/chat/completions'],
    ])('with the base URL suffix %j the request goes to %s', async (suffix, path) => {
      endpoint.handler = sse(chunk({ content: 'ok' }), DONE);

      await run({}, instance({ baseUrl: origin + suffix }));

      expect(endpoint.requests[0]?.url).toBe(path);
    });

    test('sends no Authorization header when no key is configured, and no model or effort when absent', async () => {
      adapter = build({});
      endpoint.handler = sse(chunk({ content: 'ok' }), DONE);
      const { model: _model, ...withoutModel } = request();

      const events = await collect(adapter.run(instance({ hasApiKey: false }), withoutModel));

      expect(events.at(-1)?.type).toBe('done');
      expect(endpoint.requests[0]?.headers.authorization).toBeUndefined();
      expect(endpoint.requests[0]?.body).toEqual({
        messages: [{ role: 'user', content: 'What is 2 + 2?' }],
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    test('treats an empty stored key as no key', async () => {
      adapter = build({ [SECRET_KEYS.providerApiKey('local')]: '' });
      endpoint.handler = sse(chunk({ content: 'ok' }), DONE);

      await run();

      expect(endpoint.requests[0]?.headers.authorization).toBeUndefined();
    });

    test('uses the key of the instance that is asked', async () => {
      adapter = build({
        [SECRET_KEYS.providerApiKey('local')]: KEY,
        [SECRET_KEYS.providerApiKey('other')]: 'sk-other-key',
      });
      endpoint.handler = sse(chunk({ content: 'ok' }), DONE);

      await run({}, instance({ id: 'other' }));

      expect(endpoint.requests[0]?.headers.authorization).toBe('Bearer sk-other-key');
    });

    test('parses events split at arbitrary byte boundaries, CRLF line endings and comments', async () => {
      const stream = [
        ': keep-alive\r\n\r\n',
        chunk({ content: 'Grüße, ' }).replaceAll('\n', '\r\n'),
        'event: message\r\n',
        chunk({ content: '世界 🙂' }).replaceAll('\n', '\r\n'),
        ': another comment\r\n\r\n',
        DONE.replaceAll('\n', '\r\n'),
      ].join('');
      endpoint.handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        const bytes = Buffer.from(stream, 'utf8');
        let offset = 0;
        const next = (): void => {
          if (offset >= bytes.length) return void response.end();
          response.write(bytes.subarray(offset, (offset += 5)), () => setImmediate(next));
        };
        next();
      };

      const events = await run();

      expect(answerOf(events)).toBe('Grüße, 世界 🙂');
      expect(events.at(-1)?.type).toBe('done');
    });

    test('stops reading at [DONE] even when the server keeps the connection open', async () => {
      endpoint.handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(chunk({ content: 'done early' }) + DONE);
      };

      const events = await run();

      expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
    });

    test.each(['', '\n', '\r\n', '\r'])(
      'keeps a last event that is not closed by a blank line (ending %j)',
      async (ending) => {
        endpoint.handler = sse(
          chunk({ content: 'Hel' }),
          chunk({ content: 'lo' }).trimEnd() + ending,
        );

        const events = await run();

        expect(answerOf(events)).toBe('Hello');
        expect(events.at(-1)?.type).toBe('done');
      },
    );

    test('a last event cut off in the middle adds nothing and does not fail the answer', async () => {
      endpoint.handler = sse(chunk({ content: 'Hel' }), chunk({ content: 'lo' }).slice(0, 20));

      const events = await run();

      expect(answerOf(events)).toBe('Hel');
      expect(events.at(-1)?.type).toBe('done');
    });

    test('accepts a stream that ends without [DONE]', async () => {
      endpoint.handler = sse(chunk({ content: 'no terminator' }), FINISH);

      const events = await run();

      expect(answerOf(events)).toBe('no terminator');
      expect(events.at(-1)?.type).toBe('done');
    });

    test('reads content given as a list of parts and usage in the alternative field names', async () => {
      endpoint.handler = sse(
        chunk({
          content: [
            { type: 'text', text: 'part one, ' },
            { type: 'text', text: 'part two' },
            { type: 'image' },
          ],
        }),
        chunk({}, { usage: { input_tokens: 4, output_tokens: 6 } }),
        DONE,
      );

      const events = await run();

      expect(answerOf(events)).toBe('part one, part two');
      expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 4, outputTokens: 6 } });
    });

    test('skips unparsable and unknown stream payloads', async () => {
      endpoint.handler = sse(
        'data: {not json}\n\n',
        'data: "a string"\n\n',
        `data: ${JSON.stringify({ object: 'ping' })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 't' }] } }] })}\n\n`,
        chunk({ content: 'still fine' }),
        DONE,
      );

      const events = await run();

      expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
      expect(answerOf(events)).toBe('still fine');
    });

    test('asks again without stream_options when the server rejects that option', async () => {
      endpoint.handler = (recorded, response, raw) => {
        if (recorded.body?.stream_options !== undefined) {
          json(400, {
            error: { message: 'Unrecognized request argument supplied: stream_options' },
          })(recorded, response, raw);
        } else {
          sse(chunk({ content: 'second try' }), DONE)(recorded, response, raw);
        }
      };

      const events = await run();

      expect(answerOf(events)).toBe('second try');
      expect(events.at(-1)).toEqual({ type: 'done', elapsedMs: expect.any(Number) as number });
      expect(endpoint.requests.map((sent) => sent.body?.stream_options)).toEqual([
        { include_usage: true },
        undefined,
      ]);
    });

    test('reports the second failure when the request without stream_options fails too', async () => {
      endpoint.handler = (recorded, response, raw) => {
        if (recorded.body?.stream_options !== undefined) {
          json(422, { detail: 'extra fields not permitted: include_usage' })(
            recorded,
            response,
            raw,
          );
        } else {
          json(401, { error: { message: 'Invalid API key' } })(recorded, response, raw);
        }
      };

      const events = await run();

      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in' });
      expect(endpoint.requests).toHaveLength(2);
    });

    test('does not ask again for any other rejection: there are no automatic retries', async () => {
      endpoint.handler = json(400, { error: { message: 'messages: field required' } });

      const events = await run();

      expect(events.at(-1)).toEqual({
        type: 'error',
        code: 'unknown',
        message: 'HTTP 400: messages: field required',
      });
      expect(endpoint.requests).toHaveLength(1);
    });

    test.each([
      [401, { error: { message: 'Incorrect API key provided' } }, 'not_logged_in'],
      [403, { error: { message: 'Country not supported' } }, 'not_logged_in'],
      [
        404,
        { error: { message: 'The model `chat-large` does not exist', code: 'model_not_found' } },
        'model_not_found',
      ],
      [404, { detail: 'Not Found' }, 'unsupported'],
      [429, { error: { message: 'Rate limit reached' } }, 'rate_limited'],
      [
        429,
        { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } },
        'quota',
      ],
      [500, { error: { message: 'boom' } }, 'unknown'],
      [503, { error: { message: 'loading model' } }, 'network'],
    ] as const)('HTTP %d %j ends with the error code %s', async (status, body, code) => {
      endpoint.handler = json(status, body);

      const events = await run();

      expect(typesOf(events)).toEqual(['start', 'error']);
      expect(events.at(-1)).toMatchObject({ code });
      expect(endpoint.requests).toHaveLength(1);
    });

    test('an error page that is not JSON becomes a plain status message', async () => {
      endpoint.handler = (_request, response) => {
        response.writeHead(502, { 'Content-Type': 'text/html' });
        response.end('<html><h1>502 Bad Gateway</h1>/srv/internal/path</html>');
      };

      expect((await run()).at(-1)).toEqual({
        type: 'error',
        code: 'network',
        message: 'The endpoint answered HTTP 502.',
      });
    });

    test('never shows or logs the API key, even when the endpoint echoes it', async () => {
      endpoint.handler = json(401, { error: { message: `Incorrect API key provided: ${KEY}` } });

      const events = await run();

      expect(JSON.stringify(events)).not.toContain(KEY);
      expect(JSON.stringify(logger.entries)).not.toContain(KEY);
    });

    test('an error object inside the stream ends the run with that error', async () => {
      endpoint.handler = sse(
        chunk({ content: 'partial' }),
        `data: ${JSON.stringify({ error: { message: 'Rate limit exceeded mid-stream', type: 'rate_limit_error' } })}\n\n`,
        chunk({ content: 'ignored' }),
        DONE,
      );

      const events = await run();

      expect(typesOf(events)).toEqual(['start', 'delta', 'error']);
      expect(events.at(-1)).toMatchObject({ code: 'rate_limited' });
    });

    test('accepts a whole JSON completion from a server that ignores stream', async () => {
      endpoint.handler = json(200, {
        choices: [
          {
            message: { role: 'assistant', content: 'All at once', reasoning_content: 'thought' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });

      const events = await run();

      expect(reasoningOf(events)).toBe('thought');
      expect(answerOf(events)).toBe('All at once');
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        usage: { inputTokens: 3, outputTokens: 2 },
      });
    });

    test('reports bad_output for a successful response without any completion data', async () => {
      endpoint.handler = sse(': nothing\n\n');
      expect((await run()).at(-1)).toMatchObject({ type: 'error', code: 'bad_output' });

      endpoint.handler = json(200, { hello: 'world' });
      expect((await run()).at(-1)).toMatchObject({ type: 'error', code: 'bad_output' });
    });

    test('reports a network error when nothing listens at the address', async () => {
      const dead = origin;
      await endpoint.stop();

      const events = await run({}, instance({ baseUrl: dead }));

      expect(events).toEqual([
        { type: 'start', streaming: 'token' },
        {
          type: 'error',
          code: 'network',
          message: 'The endpoint could not be reached (ECONNREFUSED).',
        },
      ]);
    });

    test('reports a network error when the connection breaks mid-stream', async () => {
      endpoint.handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(chunk({ content: 'half' }), () => response.destroy());
      };

      const events = await run();

      expect(answerOf(events)).toBe('half');
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'network' });
    });

    test('reports an invalid base URL without sending anything', async () => {
      const events = await run({}, instance({ baseUrl: 'not a url' }));

      expect(events.at(-1)).toEqual({
        type: 'error',
        code: 'unsupported',
        message: 'The base URL is not valid.',
      });
      expect(endpoint.requests).toHaveLength(0);
    });

    test('a request aborted before the start sends nothing', async () => {
      const events = await run({ signal: AbortSignal.abort() });

      expect(events).toEqual([
        { type: 'start', streaming: 'token' },
        { type: 'error', code: 'cancelled', message: expect.any(String) as string },
      ]);
      expect(endpoint.requests).toHaveLength(0);
    });

    test('abort while waiting for the response headers ends promptly and closes the connection', async () => {
      let closed = false;
      endpoint.handler = (_request, _response, raw) => {
        raw.socket.on('close', () => (closed = true));
      };
      const stop = new AbortController();
      const done = run({ signal: stop.signal });
      await until(() => endpoint.requests.length === 1);

      stop.abort();

      expect((await done).at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
      await until(() => closed);
    });

    test('abort in the middle of the stream ends promptly and closes the connection', async () => {
      let closed = false;
      endpoint.handler = (_request, response, raw) => {
        raw.socket.on('close', () => (closed = true));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(chunk({ content: 'first' }));
      };
      const stop = new AbortController();
      const events: ProviderEvent[] = [];

      for await (const event of adapter.run(instance(), request({ signal: stop.signal }))) {
        events.push(event);
        if (event.type === 'delta') stop.abort();
      }

      expect(typesOf(events)).toEqual(['start', 'delta', 'error']);
      expect(events.at(-1)).toMatchObject({ code: 'cancelled' });
      await until(() => closed);
    });

    test('a consumer that abandons the iteration closes the connection', async () => {
      let closed = false;
      endpoint.handler = (_request, response, raw) => {
        raw.socket.on('close', () => (closed = true));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(chunk({ content: 'first' }));
      };

      for await (const event of adapter.run(instance(), request())) {
        if (event.type === 'delta') break;
      }

      await until(() => closed);
    });
  });

  describe('detect and listModels', () => {
    const MODELS = {
      object: 'list',
      data: [{ id: 'chat-large' }, { id: 'text-embedding-3-large' }],
    };

    test('a reachable endpoint with a key is ready and bills the key', async () => {
      endpoint.handler = json(200, MODELS);

      expect(await adapter.detect(instance())).toEqual({
        installed: true,
        loggedIn: 'yes',
        billing: 'api-key',
        streaming: 'token',
      });
      expect(endpoint.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
      expect(endpoint.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    });

    test('without a key no Authorization header is sent and billing is unknown', async () => {
      adapter = build({});
      endpoint.handler = json(200, MODELS);

      expect(await adapter.detect(instance({ hasApiKey: false }))).toMatchObject({
        loggedIn: 'yes',
        billing: 'unknown',
      });
      expect(endpoint.requests[0]?.headers.authorization).toBeUndefined();
    });

    test.each([401, 403])('HTTP %d means the key was rejected', async (status) => {
      endpoint.handler = json(status, { error: { message: `bad key ${KEY}` } });

      const detection = await adapter.detect(instance());

      expect(detection).toEqual({
        installed: true,
        loggedIn: 'no',
        billing: 'api-key',
        streaming: 'token',
        hint: `The endpoint rejected the API key (HTTP ${status}).`,
      });
    });

    test('HTTP 401 without a key says that one is required', async () => {
      adapter = build({});
      endpoint.handler = json(401, {});

      expect((await adapter.detect(instance({ hasApiKey: false }))).hint).toBe(
        'The endpoint requires an API key (HTTP 401).',
      );
    });

    test('an endpoint without a model list is still usable', async () => {
      endpoint.handler = json(404, { detail: 'Not Found' });

      expect(await adapter.detect(instance())).toMatchObject({
        installed: true,
        loggedIn: 'unknown',
        hint: 'The endpoint has no usable model list (HTTP 404); add model names by hand.',
      });
      expect(await adapter.listModels?.(instance())).toEqual([]);
    });

    test('an unreachable endpoint is reported as such', async () => {
      await endpoint.stop();

      expect(await adapter.detect(instance())).toEqual({
        installed: false,
        loggedIn: 'unknown',
        billing: 'api-key',
        streaming: 'token',
        hint: 'The endpoint could not be reached (ECONNREFUSED).',
      });
    });

    test('an invalid base URL is reported without any request', async () => {
      expect(await adapter.detect(instance({ baseUrl: 'nonsense' }))).toMatchObject({
        installed: false,
        hint: 'The base URL is not valid.',
      });
    });

    test('gives up on an endpoint that does not answer within the detection timeout', async () => {
      const clock = new FakeClock();
      adapter = build({}, clock);
      endpoint.handler = () => undefined;
      const pending = adapter.detect(instance());
      await until(() => endpoint.requests.length === 1);

      await clock.advance(15_000);

      expect(await pending).toMatchObject({
        installed: false,
        hint: 'The endpoint did not answer in time.',
      });
      expect(clock.pendingTimers).toBe(0);
    });

    test('shutdown interrupts a pending detection and prevents new ones', async () => {
      endpoint.handler = () => undefined;
      const pending = adapter.detect(instance());
      await until(() => endpoint.requests.length === 1);

      shutdown.abort();

      expect(await pending).toMatchObject({ installed: false, hint: 'Detection was interrupted.' });
      expect(await adapter.listModels?.(instance())).toEqual([]);
      expect(endpoint.requests).toHaveLength(1);
    });

    test('lists the chat models of the endpoint', async () => {
      endpoint.handler = json(200, MODELS);

      expect(await adapter.listModels?.(instance())).toEqual([{ id: 'chat-large' }]);
    });

    test.each([
      ['a body that is not JSON', 'ok'],
      ['JSON of another shape', '{"status":"ok"}'],
      ['an empty body', ''],
    ])('tolerates %s as the model list', async (_, body) => {
      endpoint.handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
      };

      expect(await adapter.listModels?.(instance())).toEqual([]);
      expect(await adapter.detect(instance())).toMatchObject({ installed: true, loggedIn: 'yes' });
    });
  });
});
