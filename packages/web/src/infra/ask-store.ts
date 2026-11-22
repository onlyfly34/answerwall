import { createSignal } from 'solid-js';
import type { AskSnapshot } from '@answerwall/core/protocol';
import type { ApiClient, AskStream, AskStreamStore } from '../contracts/services.ts';

export interface AskStoreDeps {
  api: Pick<ApiClient, 'ask' | 'getAsk' | 'cancelAsk'>;
  /** Starts following an ask; with `initial` the stream skips loading the snapshot. */
  open(askId: string, initial?: AskSnapshot): AskStream;
}

/** At most one ask is followed at a time; following another closes the previous stream. */
export function createAskStreamStore(deps: AskStoreDeps): AskStreamStore {
  const [current, setCurrent] = createSignal<AskStream>();

  function replace(stream: AskStream | undefined): void {
    current()?.close();
    setCurrent(stream);
  }

  function isFollowing(stream: AskStream): boolean {
    const connection = stream.connection();
    return connection !== 'closed' && connection !== 'failed';
  }

  return {
    current,
    async submit(request) {
      const { askId } = await deps.api.ask(request);
      // Best effort: with the snapshot in hand the cells exist before the first
      // event. Without it the stream loads the snapshot itself, with retries.
      const initial = await deps.api.getAsk(askId).catch(() => undefined);
      const stream = deps.open(askId, initial);
      replace(stream);
      return stream;
    },
    follow(askId) {
      const existing = current();
      if (existing?.askId === askId && isFollowing(existing)) return existing;
      const stream = deps.open(askId);
      replace(stream);
      return stream;
    },
    async cancel(slotId) {
      const stream = current();
      if (stream) await deps.api.cancelAsk(stream.askId, slotId);
    },
    clear() {
      replace(undefined);
    },
  };
}
