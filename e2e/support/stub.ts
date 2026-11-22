/**
 * Loopback HTTP servers the tests script:
 *
 * - an OpenAI-compatible endpoint whose answers the test chooses chunk by
 *   chunk and can hold at a chosen point, so "mid-stream" is a state the test
 *   controls instead of a race;
 * - a canary on another origin that records every request it receives, as a
 *   target for hostile content;
 * - a relay in front of the server whose connections the test can cut.
 *
 * None of them ever leaves the machine.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { ProviderInstance } from './server.ts';

export interface StubScript {
  /** The answer, in the pieces it is streamed in. */
  chunks: string[];
  /** Milliseconds between two pieces (default 0). */
  delayMs?: number;
  /**
   * Indices at which the stream stops before sending that piece, in ascending
   * order. The n-th hold ends with the n-th `release`.
   */
  holdAt?: number[];
  reasoning?: string;
  /** Answer with this HTTP error instead of a stream. */
  error?: { status: number; body: unknown };
}

interface ModelState {
  script: StubScript;
  releases: number;
  waiters: (() => void)[];
  /** Pieces sent, per request, in arrival order. */
  sent: number[];
  /** Requests currently parked at a hold. */
  held: number;
}

export interface StubEndpoint {
  url: string;
  /** Defines (or replaces) what the model answers. */
  script(model: string, script: StubScript): void;
  /** Ends the current hold of every request for the model. */
  release(model: string): void;
  /** Resolves once `count` requests for the model are parked at a hold. */
  held(model: string, count?: number): Promise<void>;
  /** How many chat requests arrived for the model. */
  requests(model: string): number;
  /** The provider instance to store in the server's settings. */
  instance(overrides?: Partial<ProviderInstance>): ProviderInstance;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function trackSockets(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

export const STUB_API_KEY = 'e2e-stub-key-0123456789';

export async function startStub(): Promise<StubEndpoint> {
  const models = new Map<string, ModelState>();
  const state = (model: string): ModelState => {
    const found = models.get(model);
    if (!found) throw new Error(`The stub has no script for model "${model}"`);
    return found;
  };

  function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  async function chat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(request)) as { model?: string };
    const model = models.get(body.model ?? '');
    if (!model) {
      json(response, 404, { error: { message: `The model ${body.model} does not exist` } });
      return;
    }
    const { script } = model;
    const index = model.sent.push(0) - 1;
    if (script.error) {
      json(response, script.error.status, script.error.body);
      return;
    }

    let closed = false;
    response.on('close', () => {
      closed = true;
      for (const wake of model.waiters.splice(0)) wake();
    });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (payload: unknown): void =>
      void response.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (script.reasoning) {
      send({ choices: [{ index: 0, delta: { reasoning_content: script.reasoning } }] });
    }
    for (const [position, chunk] of script.chunks.entries()) {
      const hold = script.holdAt?.indexOf(position) ?? -1;
      if (hold !== -1 && model.releases <= hold) {
        model.held += 1;
        while (model.releases <= hold && !closed) {
          await new Promise<void>((resolve) => model.waiters.push(resolve));
        }
        model.held -= 1;
      }
      if (closed) return;
      send({ choices: [{ index: 0, delta: { content: chunk } }] });
      model.sent[index] = position + 1;
      if (script.delayMs) await sleep(script.delayMs);
    }
    if (closed) return;
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: script.chunks.length } });
    response.end('data: [DONE]\n\n');
  }

  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${STUB_API_KEY}`) {
      json(response, 401, { error: { message: 'Incorrect API key provided' } });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      json(response, 200, {
        object: 'list',
        data: [...models.keys()].map((id) => ({ id, object: 'model' })),
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      chat(request, response).catch(() => response.destroy());
      return;
    }
    json(response, 404, { error: { message: 'Not found' } });
  });
  const close = trackSockets(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    script(model, script) {
      models.set(model, { script, releases: 0, waiters: [], sent: [], held: 0 });
    },
    release(model) {
      const current = state(model);
      current.releases += 1;
      for (const wake of current.waiters.splice(0)) wake();
    },
    async held(model, count = 1) {
      const deadline = Date.now() + 20_000;
      while (state(model).held < count) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} held request(s) of "${model}"`);
        }
        await sleep(20);
      }
    },
    requests: (model) => state(model).sent.length,
    instance(overrides = {}) {
      const ids = [...models.keys()];
      return {
        id: 'stub',
        kind: 'openai-compat',
        label: 'Stub endpoint',
        enabled: true,
        concurrency: 4,
        models: ids,
        ...(ids[0] === undefined ? {} : { defaultModel: ids[0] }),
        baseUrl: url,
        apiKey: STUB_API_KEY,
        ...overrides,
      };
    },
    close,
  };
}

export interface CanaryRequest {
  method: string;
  url: string;
}

export interface Canary {
  /** An origin that is neither the server's nor anything the page may talk to. */
  origin: string;
  requests: CanaryRequest[];
  close(): Promise<void>;
}

export async function startCanary(): Promise<Canary> {
  const requests: CanaryRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '' });
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('canary');
  });
  const close = trackSockets(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close,
  };
}

export interface FlakyLink {
  /** The address the browser uses instead of the server's own. */
  origin: string;
  /** Cuts every connection and refuses new ones, like a network that went away. */
  sever(): void;
  /** Accepts connections again. */
  restore(): void;
  close(): Promise<void>;
}

/**
 * A TCP relay in front of a server. Browsers offer no way to break a
 * connection that is already streaming; cutting the relay does exactly that,
 * while the server itself keeps running.
 */
export async function startFlakyLink(targetPort: number): Promise<FlakyLink> {
  const pairs = new Set<Socket>();
  let severed = false;
  const relay = createNetServer((client) => {
    if (severed) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    for (const socket of [client, upstream]) {
      pairs.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => {
        pairs.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  return {
    origin: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    sever() {
      severed = true;
      for (const socket of pairs) socket.destroy();
    },
    restore() {
      severed = false;
    },
    async close() {
      for (const socket of pairs) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    },
  };
}
