/**
 * The content script. It is declared for the listed vendor hosts in every
 * frame, and does nothing at all unless its frame sits directly under this
 * extension's own wall page: in an ordinary tab of the same site it returns
 * on the first line and leaves no mark.
 */
import { ruleForHost } from '../rules/data.ts';
import { HELLO_SOURCE, PORT_NAME } from '../shared/protocol.ts';
import type { FromContent, HelloMessage, ToContent } from '../shared/protocol.ts';
import { DEFAULT_TIMING, runRule } from './engine.ts';
import { isUnderWall } from './gate.ts';

function start(): void {
  const rule = ruleForHost(location.hostname);
  if (!rule) return;

  const port = chrome.runtime.connect({ name: PORT_NAME });
  const send = (message: FromContent): void => {
    try {
      port.postMessage(message);
    } catch {
      // The wall page is gone; so is every run.
    }
  };
  const runs = new Map<number, AbortController>();
  port.onDisconnect.addListener(() => {
    for (const run of runs.values()) run.abort();
    runs.clear();
  });

  port.onMessage.addListener((raw) => {
    const message = raw as ToContent;
    if (message.type === 'abort') {
      runs.get(message.id)?.abort();
      runs.delete(message.id);
      return;
    }
    if (message.type !== 'run') return;
    const { id } = message;
    const controller = new AbortController();
    runs.set(id, controller);
    void runRule(
      rule,
      {
        document,
        pathname: () => location.pathname,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        timing: DEFAULT_TIMING,
      },
      {
        prompt: message.prompt,
        fill: message.fill,
        read: message.read,
        resume: message.resume,
        signal: controller.signal,
        onStage: (stage) => send({ type: 'stage', id, stage }),
      },
    )
      .catch(() => ({ outcome: 'failed', code: 'unknown', detail: 'answer' }) as const)
      .then((result) => {
        runs.delete(id);
        if (result) send({ type: 'result', id, result });
      });
  });

  // The same random value over the port and to the parent window: the wall
  // page learns which of its frames this port belongs to. The message is
  // addressed to the extension's origin, so no other page can receive it.
  const nonce = crypto.randomUUID();
  send({ type: 'hello', nonce });
  window.parent.postMessage(
    { source: HELLO_SOURCE, nonce } satisfies HelloMessage,
    `chrome-extension://${chrome.runtime.id}`,
  );
}

if (
  isUnderWall({
    self: window,
    parent: window.parent,
    top: window.top,
    ancestorOrigins: location.ancestorOrigins,
    extensionId: chrome.runtime.id,
  })
) {
  start();
}
