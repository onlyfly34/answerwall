/**
 * The wall page's side of a web cell: which frame belongs to which content
 * script, whether a frame can be driven at all, and one run at a time per
 * frame. The wall (packages/web) sees it as a `WebCellHost`.
 *
 * A content script announces itself twice with the same random value: over
 * a runtime port (which says which tab it is in, but not which frame
 * element) and with a `postMessage` from its window (whose `source` is the
 * frame's window). A port is used only once both have arrived, came from
 * this tab, and the message came from the origin the frame was opened at.
 */
import { createSignal } from 'solid-js';
import type { WebSiteId } from '@answerwall/core/protocol';
import type {
  WebCellConnection,
  WebCellFrame,
  WebCellHost,
  WebCellRunOptions,
  WebCellRunResult,
  WebCellSite,
} from '@answerwall/web/embed';
import { isHelloMessage, PORT_NAME } from '../shared/protocol.ts';
import type { FromContent, ToContent } from '../shared/protocol.ts';

export type Port = chrome.runtime.Port;

export interface HostEnvironment {
  /** The tab this wall page is in: only content scripts of this tab are its cells. */
  tabId: number;
  sites(site: WebSiteId): WebCellSite | undefined;
  onConnect: Pick<typeof chrome.runtime.onConnect, 'addListener'>;
  /** The window that receives the frames' `message` events. */
  window: Pick<Window, 'addEventListener'>;
  timing?: Partial<HostTiming>;
}

export interface HostTiming {
  /** After a frame has loaded, how long its content script may take to answer. */
  helloMs: number;
  /** How long a run waits for a frame that is still loading. */
  connectMs: number;
  /** After the page was replaced mid-run, how long its successor may take. */
  resumeMs: number;
}

export const DEFAULT_HOST_TIMING: HostTiming = {
  helloMs: 5_000,
  connectMs: 20_000,
  resumeMs: 20_000,
};

/** Announcements that have not found their other half; a page cannot grow this without bound. */
const MAX_PENDING = 64;

interface ActiveRun {
  id: number;
  options: WebCellRunOptions;
  /** The content script reported that the prompt was submitted in the page. */
  submitted: boolean;
  finish(result: WebCellRunResult): void;
}

interface Cell {
  element: HTMLIFrameElement;
  origin: string;
  port: Port | undefined;
  setConnection(connection: WebCellConnection): void;
  connection(): WebCellConnection;
  helloTimer: ReturnType<typeof setTimeout> | undefined;
  run: ActiveRun | undefined;
  /** Called when a port arrives. */
  waiting: Set<() => void>;
  disposed: boolean;
}

export function createWebCellHost(environment: HostEnvironment): WebCellHost {
  const timing = { ...DEFAULT_HOST_TIMING, ...environment.timing };
  const cells = new Set<Cell>();
  /** Ports that said hello, and frames whose window did, by nonce. */
  const ports = new Map<string, Port>();
  const windows = new Map<string, Cell>();
  let nextRunId = 1;

  function remember<T>(map: Map<string, T>, nonce: string, value: T): void {
    if (map.size >= MAX_PENDING) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(nonce, value);
  }

  /** Without an announcement within `ms`, the frame shows something the extension has no part in. */
  function expectHello(cell: Cell, ms: number): void {
    clearTimeout(cell.helloTimer);
    cell.helloTimer = setTimeout(() => {
      if (!cell.port && !cell.disposed) cell.setConnection('unreachable');
    }, ms);
  }

  function bind(nonce: string): void {
    const port = ports.get(nonce);
    const cell = windows.get(nonce);
    if (!port || !cell) return;
    ports.delete(nonce);
    windows.delete(nonce);
    if (cell.disposed) return;
    clearTimeout(cell.helloTimer);
    cell.port = port;
    cell.setConnection('ready');
    port.onMessage.addListener((raw) => {
      const message = raw as FromContent;
      const run = cell.run;
      if (cell.port !== port || !run || message.type === 'hello' || message.id !== run.id) return;
      if (message.type === 'stage') {
        if (message.stage === 'answering') run.submitted = true;
        run.options.onStage?.(message.stage);
      } else {
        run.finish(message.result);
      }
    });
    port.onDisconnect.addListener(() => {
      if (cell.port !== port) return;
      // The frame's document went away: a navigation, a reload, or the frame itself.
      cell.port = undefined;
      if (cell.disposed) return;
      cell.setConnection('loading');
      expectHello(cell, timing.connectMs);
      const run = cell.run;
      if (run) void resume(cell, run);
    });
    for (const waiter of [...cell.waiting]) waiter();
  }

  environment.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME || port.sender?.tab?.id !== environment.tabId) return;
    const onHello = (raw: unknown): void => {
      const message = raw as FromContent;
      if (message.type !== 'hello' || typeof message.nonce !== 'string') return;
      port.onMessage.removeListener(onHello);
      remember(ports, message.nonce, port);
      bind(message.nonce);
    };
    port.onMessage.addListener(onHello);
  });

  environment.window.addEventListener('message', (event: MessageEvent) => {
    if (!isHelloMessage(event.data)) return;
    for (const cell of cells) {
      if (cell.element.contentWindow !== event.source) continue;
      // Only the site the cell was opened for: not whatever the frame went to.
      if (event.origin !== cell.origin) return;
      remember(windows, event.data.nonce, cell);
      bind(event.data.nonce);
      return;
    }
  });

  /** Resolves `true` once the cell has a port, `false` after `ms` or on abort. */
  function connected(cell: Cell, ms: number, signal: AbortSignal): Promise<boolean> {
    if (cell.port) return Promise.resolve(true);
    if (cell.disposed || signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        cell.waiting.delete(onPort);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onPort = (): void => done(true);
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(false), ms);
      cell.waiting.add(onPort);
      signal.addEventListener('abort', onAbort);
    });
  }

  function send(cell: Cell, message: ToContent): boolean {
    try {
      cell.port?.postMessage(message);
      return cell.port !== undefined;
    } catch {
      return false;
    }
  }

  const noConnection: WebCellRunResult = {
    outcome: 'failed',
    code: 'unsupported',
    detail: 'no_connection',
  };

  /**
   * The page was replaced while a run was under way. A site may load a new
   * document for the conversation it just started: when the prompt had been
   * submitted and the answer is to be read, the run goes on in the new page
   * without typing again. A run that types nothing (the user does) starts
   * watching the new page afresh, so that what is already on it is never
   * taken for the answer. Otherwise the run ends: typing twice is never an
   * option.
   */
  async function resume(cell: Cell, run: ActiveRun): Promise<void> {
    const { fill, read, signal } = run.options;
    if (!read || (fill && !run.submitted)) {
      run.finish(noConnection);
      return;
    }
    const again = await connected(cell, timing.resumeMs, signal);
    if (cell.run !== run) return;
    if (
      !again ||
      !send(cell, { type: 'run', id: run.id, prompt: '', fill: false, read: true, resume: fill })
    ) {
      run.finish(noConnection);
    }
  }

  return {
    site: (site) => environment.sites(site),

    attach(element, site): WebCellFrame {
      const info = environment.sites(site);
      const [connection, setConnection] = createSignal<WebCellConnection>('loading');
      const cell: Cell = {
        element,
        origin: info ? new URL(info.url).origin : '',
        port: undefined,
        connection,
        setConnection,
        helloTimer: undefined,
        run: undefined,
        waiting: new Set(),
        disposed: false,
      };
      cells.add(cell);

      // A document that loaded without a content script answering is one the
      // extension has no part in: the browser's refusal page, or another host.
      const onLoad = (): void => {
        if (!cell.port) expectHello(cell, timing.helloMs);
      };
      element.addEventListener('load', onLoad);
      // In case the frame never reports a load at all.
      expectHello(cell, timing.connectMs);

      return {
        connection,
        async run(options): Promise<WebCellRunResult> {
          if (cell.run || cell.disposed) return noConnection;
          if (options.signal.aborted) return { outcome: 'aborted' };
          return new Promise<WebCellRunResult>((resolve) => {
            const run: ActiveRun = {
              id: nextRunId++,
              options,
              submitted: false,
              finish(result) {
                if (cell.run !== run) return;
                cell.run = undefined;
                options.signal.removeEventListener('abort', onAbort);
                resolve(result);
              },
            };
            const onAbort = (): void => {
              send(cell, { type: 'abort', id: run.id });
              run.finish({ outcome: 'aborted' });
            };
            cell.run = run;
            options.signal.addEventListener('abort', onAbort);

            void connected(cell, timing.connectMs, options.signal).then((ready) => {
              if (cell.run !== run) return;
              const started =
                ready &&
                send(cell, {
                  type: 'run',
                  id: run.id,
                  prompt: options.prompt,
                  fill: options.fill,
                  read: options.read,
                  resume: false,
                });
              if (!started) run.finish(noConnection);
            });
          });
        },
        dispose() {
          cell.disposed = true;
          clearTimeout(cell.helloTimer);
          element.removeEventListener('load', onLoad);
          cells.delete(cell);
          const run = cell.run;
          if (run) {
            send(cell, { type: 'abort', id: run.id });
            run.finish({ outcome: 'aborted' });
          }
          for (const waiter of [...cell.waiting]) waiter();
          cell.port = undefined;
        },
      };
    },
  };
}
