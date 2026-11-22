import { batch, createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createParser } from 'eventsource-parser';
import {
  API_PATHS,
  applyStreamEvent,
  isTerminalStreamEvent,
  SSE_PING_INTERVAL_MS,
  StreamEventSchema,
} from '@answerwall/core/protocol';
import type { AskSnapshot, StreamEvent } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { ApiClient, AskStream, Notifier, StreamConnection } from '../contracts/services.ts';
import { readApiError } from './api.ts';
import type { Fetch } from './api.ts';
import type { Visibility } from './visibility.ts';

export interface AskStreamTuning {
  /** Received events are folded into the store at most once per this interval. */
  throttleMs: number;
  /** Delay before the first reconnect; doubles per failed attempt up to `backoffMaxMs`. */
  backoffInitialMs: number;
  backoffMaxMs: number;
  /** A connection that delivers nothing for this long, pings included, is replaced. */
  stallMs: number;
}

export const DEFAULT_STREAM_TUNING: AskStreamTuning = {
  throttleMs: 80,
  backoffInitialMs: 500,
  backoffMaxMs: 15_000,
  stallMs: SSE_PING_INTERVAL_MS * 3,
};

export interface AskStreamDeps {
  api: Pick<ApiClient, 'getAsk'>;
  fetch: Fetch;
  notify: Pick<Notifier, 'reportError'>;
  visibility: Visibility;
  /** In [0, 1); spreads reconnects so several pages do not retry in step. */
  random: () => number;
  tuning?: Partial<AskStreamTuning>;
}

/** How one connection attempt ended. */
type Outcome = 'terminal' | 'failed' | 'dropped' | 'stopped';

const invalidStream = (status: number) =>
  new ApiError('invalid_response', status, 'Unexpected response from the server');

/** Errors that say the ask or the session is gone, as opposed to a server having a bad moment. */
function isPermanent(error: ApiError): boolean {
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

/**
 * Follows one ask: loads its snapshot when it has none, then reads the event
 * stream from the snapshot's `seq`, resuming after every interruption until a
 * terminal event arrives. Starts immediately.
 */
export function createAskStream(
  askId: string,
  deps: AskStreamDeps,
  initial?: AskSnapshot,
): AskStream {
  const tuning = { ...DEFAULT_STREAM_TUNING, ...deps.tuning };
  const [state, setState] = createStore<{ snapshot: AskSnapshot | undefined }>({
    snapshot: initial && structuredClone(initial),
  });
  const [connection, setConnection] = createSignal<StreamConnection>('connecting');
  const [error, setError] = createSignal<ApiError>();

  /** The last `seq` received, which may be ahead of the store until the next flush. */
  let lastSeq = initial?.seq;
  let pending: StreamEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the wait between two attempts early. */
  let wake: (() => void) | undefined;
  let request: AbortController | undefined;
  let lastActivity = Date.now();
  let failedAttempts = 0;
  let stopped = false;

  function flush(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pending.length === 0) return;
    const events = pending;
    pending = [];
    batch(() =>
      setState(
        produce((draft) => {
          for (const event of events) {
            if (event.type === 'snapshot') draft.snapshot = event.snapshot;
            else if (draft.snapshot) applyStreamEvent(draft.snapshot, event);
          }
        }),
      ),
    );
  }

  /** Queues one event for the next flush. Returns whether it was terminal. */
  function receive(event: StreamEvent): boolean {
    // A resumed stream may overlap what is already here; a snapshot always replaces.
    if (event.type !== 'snapshot' && lastSeq !== undefined && event.seq <= lastSeq) return false;
    lastSeq = event.seq;
    pending.push(event);
    if (isTerminalStreamEvent(event)) return true;
    flushTimer ??= setTimeout(flush, tuning.throttleMs);
    return false;
  }

  function armStallTimer(): void {
    lastActivity = Date.now();
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => request?.abort(), tuning.stallMs);
  }

  function release(): void {
    stopped = true;
    clearTimeout(stallTimer);
    clearTimeout(retryTimer);
    unsubscribe();
    request?.abort();
    wake?.();
    flush();
  }

  function fail(failure: ApiError): Outcome {
    if (stopped) return 'stopped';
    release();
    batch(() => {
      setError(failure);
      setConnection('failed');
    });
    if (failure.status === 401) deps.notify.reportError(failure);
    return 'failed';
  }

  function finish(): Outcome {
    release();
    setConnection('closed');
    return 'terminal';
  }

  async function loadSnapshot(): Promise<Outcome | undefined> {
    let snapshot: AskSnapshot;
    try {
      snapshot = await deps.api.getAsk(askId);
    } catch (cause) {
      if (cause instanceof ApiError && (isPermanent(cause) || cause.code === 'invalid_response')) {
        return fail(cause);
      }
      return 'dropped';
    }
    if (stopped) return 'stopped';
    lastSeq = snapshot.seq;
    setState('snapshot', snapshot);
    // A finished ask has nothing to stream.
    return snapshot.status === 'done' ? finish() : undefined;
  }

  async function readEvents(
    response: Response,
    body: ReadableStream<Uint8Array>,
  ): Promise<Outcome> {
    let terminal = false;
    let malformed = false;
    let delivered = false;
    const parser = createParser({
      onEvent(message) {
        if (terminal || malformed) return;
        let payload: unknown;
        try {
          payload = JSON.parse(message.data);
        } catch {
          malformed = true;
          return;
        }
        const event = StreamEventSchema.safeParse(payload);
        if (!event.success) {
          malformed = true;
          return;
        }
        delivered = true;
        terminal = receive(event.data);
      },
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (stopped) return 'stopped';
        if (chunk.done) return 'dropped';
        armStallTimer();
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        if (malformed) return fail(invalidStream(response.status));
        if (terminal) return finish();
        // The connection works: the next interruption starts from the short delay again.
        if (delivered) failedAttempts = 0;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  async function connectOnce(): Promise<Outcome> {
    if (lastSeq === undefined) {
      const outcome = await loadSnapshot();
      if (outcome) return outcome;
    }
    request = new AbortController();
    armStallTimer();
    let response: Response;
    try {
      response = await deps.fetch(API_PATHS.askStream(askId, lastSeq), {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/event-stream' },
        signal: request.signal,
      });
    } catch {
      return stopped ? 'stopped' : 'dropped';
    }
    if (stopped) return 'stopped';
    if (!response.ok) {
      const failure = await readApiError(response);
      return isPermanent(failure) ? fail(failure) : 'dropped';
    }
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!response.body || !contentType.startsWith('text/event-stream')) {
      return fail(invalidStream(response.status));
    }
    setConnection('live');
    try {
      return await readEvents(response, response.body);
    } catch {
      // The connection broke, or the stall timer aborted it.
      return stopped ? 'stopped' : 'dropped';
    }
  }

  /** Waits out the backoff; while the page is hidden, waits for it to come back instead. */
  function waitToRetry(): Promise<void> {
    const ceiling = Math.min(
      tuning.backoffMaxMs,
      tuning.backoffInitialMs * 2 ** Math.min(failedAttempts, 16),
    );
    failedAttempts += 1;
    const delay = ceiling * (0.5 + deps.random() / 2);
    return new Promise((resolve) => {
      wake = () => {
        clearTimeout(retryTimer);
        wake = undefined;
        resolve();
      };
      if (!deps.visibility.hidden()) retryTimer = setTimeout(() => wake?.(), delay);
    });
  }

  function onVisibilityChange(): void {
    if (deps.visibility.hidden()) {
      // No point in retrying from the background; the foreground retries at once.
      clearTimeout(retryTimer);
      return;
    }
    if (wake) wake();
    else if (Date.now() - lastActivity >= tuning.stallMs) request?.abort();
  }

  const unsubscribe = deps.visibility.subscribe(onVisibilityChange);

  async function run(): Promise<void> {
    for (;;) {
      const outcome = await connectOnce();
      if (outcome !== 'dropped' || stopped) return;
      clearTimeout(stallTimer);
      flush();
      setConnection('reconnecting');
      await waitToRetry();
      if (stopped) return;
    }
  }

  void run();

  return {
    askId,
    snapshot: () => state.snapshot,
    connection,
    error,
    close() {
      if (stopped) return;
      release();
      setConnection('closed');
    },
  };
}
