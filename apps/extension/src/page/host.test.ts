import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WebCellFrame, WebCellRunResult, WebCellStage } from '@answerwall/web/embed';
import { HELLO_SOURCE, PORT_NAME } from '../shared/protocol.ts';
import type { FromContent, ToContent } from '../shared/protocol.ts';
import { createWebCellHost } from './host.ts';
import type { Port } from './host.ts';

const TAB = 7;
const SITE_URL = 'https://claude.ai/new';
const TIMING = { helloMs: 50, connectMs: 200, resumeMs: 200 };

interface FakePort {
  port: Port;
  /** What the wall page sent to the content script. */
  sent: ToContent[];
  /** A message from the content script. */
  say(message: FromContent): void;
  /** The content script's document went away. */
  drop(): void;
}

function fakePort(tabId: number | undefined = TAB, name = PORT_NAME): FakePort {
  const onMessage = new Set<(message: unknown) => void>();
  const onDisconnect = new Set<() => void>();
  const sent: ToContent[] = [];
  let open = true;
  const port: Port = {
    name,
    sender: tabId === undefined ? {} : { tab: { id: tabId }, frameId: 1 },
    postMessage(message) {
      if (!open) throw new Error('Attempting to use a disconnected port object');
      sent.push(message as ToContent);
    },
    disconnect() {
      open = false;
    },
    onMessage: {
      addListener: (listener) => void onMessage.add(listener),
      removeListener: (listener) => void onMessage.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => void onDisconnect.add(listener),
      removeListener: (listener) => void onDisconnect.delete(listener),
    },
  };
  return {
    port,
    sent,
    say: (message) => {
      for (const listener of [...onMessage]) listener(message);
    },
    drop: () => {
      open = false;
      for (const listener of [...onDisconnect]) listener();
    },
  };
}

function harness() {
  let connectListener: ((port: Port) => void) | undefined;
  let messageListener: ((event: MessageEvent) => void) | undefined;
  const host = createWebCellHost({
    tabId: TAB,
    sites: (site) => (site === 'claude' ? { url: SITE_URL, verified: false } : undefined),
    onConnect: { addListener: (listener) => (connectListener = listener) },
    window: {
      addEventListener: (type: string, listener: unknown) => {
        if (type === 'message') messageListener = listener as (event: MessageEvent) => void;
      },
    } as Pick<Window, 'addEventListener'>,
    timing: TIMING,
  });

  function frame(): { element: HTMLIFrameElement; cell: WebCellFrame } {
    const element = document.createElement('iframe');
    document.body.append(element);
    return { element, cell: host.attach(element, 'claude') };
  }

  /** A content script in `element` announces itself over a new port and to the window. */
  function announce(
    element: HTMLIFrameElement,
    options: { nonce?: string; origin?: string; tabId?: number; viaWindow?: boolean } = {},
  ): FakePort {
    const nonce = options.nonce ?? crypto.randomUUID();
    const port = fakePort(options.tabId ?? TAB);
    connectListener?.(port.port);
    port.say({ type: 'hello', nonce });
    if (options.viaWindow !== false) {
      messageListener?.({
        data: { source: HELLO_SOURCE, nonce },
        origin: options.origin ?? 'https://claude.ai',
        source: element.contentWindow,
      } as MessageEvent);
    }
    return port;
  }

  return {
    host,
    frame,
    announce,
    connect: (port: Port) => connectListener?.(port),
    post: (event: Partial<MessageEvent>) => messageListener?.(event as MessageEvent),
  };
}

const run = (
  cell: WebCellFrame,
  options: Partial<Parameters<WebCellFrame['run']>[0]> = {},
): { result: Promise<WebCellRunResult>; stages: WebCellStage[]; controller: AbortController } => {
  const stages: WebCellStage[] = [];
  const controller = new AbortController();
  return {
    stages,
    controller,
    result: cell.run({
      prompt: 'What is a monad?',
      fill: true,
      read: true,
      signal: controller.signal,
      onStage: (stage) => void stages.push(stage),
      ...options,
    }),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('which frame a content script belongs to', () => {
  test('a cell is ready once the same value arrived over a port of this tab and from its window', () => {
    const { frame, announce, host } = harness();
    const { element, cell } = frame();
    expect(cell.connection()).toBe('loading');
    announce(element);
    expect(cell.connection()).toBe('ready');
    expect(host.site('claude')).toEqual({ url: SITE_URL, verified: false });
    expect(host.site('grok')).toBeUndefined();
  });

  test('the two halves may arrive in either order', () => {
    const { frame, connect, post } = harness();
    const { element, cell } = frame();
    post({
      data: { source: HELLO_SOURCE, nonce: 'n-1' },
      origin: 'https://claude.ai',
      source: element.contentWindow,
    });
    expect(cell.connection()).toBe('loading');
    const port = fakePort();
    connect(port.port);
    port.say({ type: 'hello', nonce: 'n-1' });
    expect(cell.connection()).toBe('ready');
  });

  test('a port of another tab, or one with another name, is never used', () => {
    const { frame, announce, connect, post } = harness();
    const { element, cell } = frame();
    announce(element, { tabId: TAB + 1 });
    expect(cell.connection()).toBe('loading');

    const stranger = fakePort(TAB, 'something-else');
    connect(stranger.port);
    stranger.say({ type: 'hello', nonce: 'n-2' });
    post({
      data: { source: HELLO_SOURCE, nonce: 'n-2' },
      origin: 'https://claude.ai',
      source: element.contentWindow,
    });
    expect(cell.connection()).toBe('loading');
  });

  test('a frame that went to another site is not connected', () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    announce(element, { origin: 'https://evil.example' });
    expect(cell.connection()).toBe('loading');
  });

  test('a window message alone connects nothing: a page cannot open a port to the extension', () => {
    const { frame, post } = harness();
    const { element, cell } = frame();
    post({
      data: { source: HELLO_SOURCE, nonce: 'made-up' },
      origin: 'https://claude.ai',
      source: element.contentWindow,
    });
    post({ data: 'noise', origin: 'https://claude.ai', source: element.contentWindow });
    post({
      data: { source: HELLO_SOURCE, nonce: 'x' },
      origin: 'https://claude.ai',
      source: window,
    });
    expect(cell.connection()).toBe('loading');
  });

  test('each of two cells gets its own port', async () => {
    const { frame, announce } = harness();
    const first = frame();
    const second = frame();
    const secondPort = announce(second.element);
    const firstPort = announce(first.element);
    void run(first.cell);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstPort.sent).toHaveLength(1);
    expect(secondPort.sent).toHaveLength(0);
  });

  test('a document that loaded without a content script answering is unreachable', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    element.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(TIMING.helloMs + 1);
    expect(cell.connection()).toBe('unreachable');
    // A later page of the site connects again (the user signed in, or reloaded).
    announce(element);
    expect(cell.connection()).toBe('ready');
  });

  test('a frame that never reports a load ends up unreachable too', async () => {
    const { frame } = harness();
    const { cell } = frame();
    await vi.advanceTimersByTimeAsync(TIMING.connectMs + 1);
    expect(cell.connection()).toBe('unreachable');
  });
});

describe('a run', () => {
  test('sends the request, passes the stages on and resolves with the result', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result, stages } = run(cell);
    await vi.advanceTimersByTimeAsync(0);

    expect(port.sent).toEqual([
      { type: 'run', id: 1, prompt: 'What is a monad?', fill: true, read: true, resume: false },
    ]);
    port.say({ type: 'stage', id: 1, stage: 'filling' });
    port.say({ type: 'stage', id: 1, stage: 'answering' });
    // Something for a run that is not this one.
    port.say({ type: 'result', id: 99, result: { outcome: 'done', text: 'not mine' } });
    port.say({ type: 'result', id: 1, result: { outcome: 'done', text: 'A monad is…' } });

    expect(await result).toEqual({ outcome: 'done', text: 'A monad is…' });
    expect(stages).toEqual(['filling', 'answering']);
  });

  test('waits for a frame that is still loading', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(TIMING.connectMs / 2);
    const port = announce(element);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toHaveLength(1);
    port.say({ type: 'result', id: 1, result: { outcome: 'submitted' } });
    expect(await result).toEqual({ outcome: 'submitted' });
  });

  test('without a connection it fails as unsupported, and nothing is typed anywhere', async () => {
    const { frame } = harness();
    const { cell } = frame();
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(TIMING.connectMs + 1);
    expect(await result).toEqual({
      outcome: 'failed',
      code: 'unsupported',
      detail: 'no_connection',
    });
  });

  test('one run at a time per frame', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const first = run(cell);
    const second = run(cell);
    expect(await second.result).toMatchObject({ outcome: 'failed', detail: 'no_connection' });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toHaveLength(1);
    port.say({ type: 'result', id: 1, result: { outcome: 'submitted' } });
    await first.result;
    // The frame is free again.
    const third = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.sent).toHaveLength(2);
    port.say({ type: 'result', id: 2, result: { outcome: 'submitted' } });
    expect(await third.result).toEqual({ outcome: 'submitted' });
  });

  test('aborting tells the content script to stop and resolves as aborted', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result, controller } = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toEqual({ outcome: 'aborted' });
    expect(port.sent.at(-1)).toEqual({ type: 'abort', id: 1 });
    // A late result of the aborted run changes nothing.
    port.say({ type: 'result', id: 1, result: { outcome: 'done', text: 'late' } });
  });

  test('a signal that already fired starts nothing', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const controller = new AbortController();
    controller.abort();
    expect(await run(cell, { signal: controller.signal }).result).toEqual({ outcome: 'aborted' });
    expect(port.sent).toEqual([]);
  });

  test('disposing the frame aborts its run', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    announce(element);
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    cell.dispose();
    expect(await result).toEqual({ outcome: 'aborted' });
    expect(await run(cell).result).toMatchObject({ outcome: 'failed' });
  });
});

describe('when the page is replaced during a run', () => {
  test('before the prompt was submitted, the run fails: the prompt is never typed twice', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    port.say({ type: 'stage', id: 1, stage: 'filling' });
    port.drop();
    expect(await result).toMatchObject({ outcome: 'failed', detail: 'no_connection' });
    expect(cell.connection()).toBe('loading');

    const next = announce(element);
    await vi.advanceTimersByTimeAsync(0);
    expect(next.sent).toEqual([]);
  });

  test('after it was submitted, the new page is only read', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    port.say({ type: 'stage', id: 1, stage: 'answering' });
    port.drop();

    const next = announce(element);
    await vi.advanceTimersByTimeAsync(0);
    expect(next.sent).toEqual([
      { type: 'run', id: 1, prompt: '', fill: false, read: true, resume: true },
    ]);
    next.say({ type: 'result', id: 1, result: { outcome: 'done', text: 'From the new page' } });
    expect(await result).toEqual({ outcome: 'done', text: 'From the new page' });
  });

  test('a new page that never connects ends the run', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result } = run(cell);
    await vi.advanceTimersByTimeAsync(0);
    port.say({ type: 'stage', id: 1, stage: 'answering' });
    port.drop();
    await vi.advanceTimersByTimeAsync(TIMING.resumeMs + 1);
    expect(await result).toMatchObject({ outcome: 'failed', detail: 'no_connection' });
    expect(cell.connection()).toBe('unreachable');
  });

  test('filling was off: the new page is watched afresh, so nothing already on it is taken for the answer', async () => {
    const { frame, announce } = harness();
    const { element, cell } = frame();
    const port = announce(element);
    const { result } = run(cell, { fill: false });
    await vi.advanceTimersByTimeAsync(0);
    port.drop();
    const next = announce(element);
    await vi.advanceTimersByTimeAsync(0);
    expect(next.sent).toEqual([
      { type: 'run', id: 1, prompt: '', fill: false, read: true, resume: false },
    ]);
    next.say({ type: 'result', id: 1, result: { outcome: 'done', text: 'x' } });
    expect(await result).toEqual({ outcome: 'done', text: 'x' });
  });
});
