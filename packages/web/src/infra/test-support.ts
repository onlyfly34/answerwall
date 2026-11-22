/**
 * Helpers for this unit's tests: a scripted `fetch`, a hand-driven event
 * stream and a page visibility the test controls. Not part of the app.
 */
import { API_VERSION, BRAND, createDefaultSettings } from '@answerwall/core/protocol';
import type { ApiErrorCode, Meta, SettingsResponse, StreamEvent } from '@answerwall/core/protocol';
import type { Fetch } from './api.ts';
import type { Visibility } from './visibility.ts';

export const TEST_VERSION = '1.2.3';

export function testMeta(overrides: Partial<Meta> = {}): Meta {
  return {
    name: BRAND.name,
    version: TEST_VERSION,
    apiVersion: API_VERSION,
    mode: 'server',
    tls: 'off',
    authRequired: true,
    ...overrides,
  };
}

export function testSettingsResponse(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    settings: createDefaultSettings(),
    server: {
      mode: 'server',
      tls: { mode: 'off', insecure: false, caCertificatePem: null },
      publicOrigins: [],
    },
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(
  code: ApiErrorCode,
  status: number,
  message: string = code,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export interface RecordedCall {
  method: string;
  url: string;
  init: RequestInit;
  /** The parsed JSON body, when there was one. */
  body: unknown;
}

export interface ScriptedFetch {
  fetch: Fetch;
  calls: RecordedCall[];
}

/** A `fetch` answered by `respond`; a thrown error becomes a rejected request. */
export function scriptedFetch(
  respond: (call: RecordedCall) => Response | Promise<Response>,
): ScriptedFetch {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const call: RecordedCall = {
        method: init.method ?? 'GET',
        url,
        init,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
  };
}

/** One open event-stream response whose chunks the test writes. */
export interface SseConnection {
  response: Response;
  /** Writes one protocol event as an SSE message. */
  send(event: StreamEvent): void;
  /** Writes raw text, for pings and malformed input. */
  write(text: string): void;
  /** The server closes the stream. */
  end(): void;
  /** The connection breaks. */
  fail(): void;
  /** The client gave up on this connection. */
  readonly aborted: boolean;
}

export function sseConnection(signal?: AbortSignal | null): SseConnection {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  let aborted = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      open = false;
    },
  });
  const close = (action: () => void): void => {
    if (!open) return;
    open = false;
    action();
  };
  signal?.addEventListener('abort', () => {
    aborted = true;
    close(() => controller.error(new DOMException('Aborted', 'AbortError')));
  });
  const write = (text: string): void => {
    if (open) controller.enqueue(encoder.encode(text));
  };
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    write,
    send: (event) =>
      write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
    end: () => close(() => controller.close()),
    fail: () => close(() => controller.error(new TypeError('network error'))),
    get aborted() {
      return aborted;
    },
  };
}

export interface FakeVisibility extends Visibility {
  /** Changes the state and notifies the listeners, as the browser does. */
  set(hidden: boolean): void;
  /** Notifies without a change of state: the device came back online. */
  online(): void;
  readonly listeners: number;
}

export function fakeVisibility(): FakeVisibility {
  let hidden = false;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    hidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next) {
      hidden = next;
      notify();
    },
    online: notify,
    get listeners() {
      return listeners.size;
    },
  };
}

export interface MemoryStorage extends Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values: Map<string, string>;
}

export function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

/** A storage that refuses everything, as browsers do with blocked site data. */
export const brokenStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('denied', 'SecurityError');
  },
};
