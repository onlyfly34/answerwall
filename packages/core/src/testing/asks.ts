import { AppError } from '../contracts/index.ts';
import type { AskManager, Clock, IdGenerator, SettingsService } from '../contracts/index.ts';
import { applyStreamEvent, initialAskSnapshot, isTerminalSlotStatus } from '../protocol/index.ts';
import type { AskRequest, AskSnapshot, StreamEvent } from '../protocol/index.ts';

/** A stream event without its `seq`; the fake assigns the next one. */
export type UnsequencedEvent = StreamEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'seq'>
    : never
  : never;

interface FakeAsk {
  snapshot: AskSnapshot;
  log: StreamEvent[];
  wake: Set<() => void>;
}

export interface FakeAskManager extends AskManager {
  /** Every request passed to `submit`, in order. */
  readonly submitted: AskRequest[];
  /** Appends an event to an ask's log and delivers it to its subscribers. */
  emit(askId: string, event: UnsequencedEvent): void;
}

/**
 * An `AskManager` without providers: `submit` only records the ask, and the
 * test drives it with `emit`. For testing the ask routes and the stream wire
 * format; the real limits and queueing live in the runner.
 */
export function createFakeAskManager(deps: {
  settings: SettingsService;
  clock: Clock;
  ids: IdGenerator;
}): FakeAskManager {
  const asks = new Map<string, FakeAsk>();
  const submitted: AskRequest[] = [];

  const find = (askId: string): FakeAsk => {
    const ask = asks.get(askId);
    if (!ask) throw new AppError('not_found', 'No such ask');
    return ask;
  };

  const emit = (askId: string, event: UnsequencedEvent): void => {
    const ask = find(askId);
    const sequenced: StreamEvent = { ...event, seq: ask.log.length + 1 };
    ask.log.push(sequenced);
    ask.snapshot = applyStreamEvent(ask.snapshot, sequenced);
    for (const wake of ask.wake) wake();
  };

  return {
    submitted,
    emit,
    async start() {},
    async submit(request) {
      submitted.push(request);
      const providers = deps.settings.get().providers;
      const targets = request.targets.map((target) => {
        const provider = providers.find((p) => p.id === target.providerId);
        if (!provider) throw new AppError('unknown_provider', `No provider "${target.providerId}"`);
        return { ...target, kind: provider.kind };
      });
      const askId = deps.ids.next();
      const snapshot = initialAskSnapshot({
        askId,
        conversationId: request.conversationId ?? deps.ids.next(),
        prompt: request.prompt,
        createdAt: deps.clock.now(),
        targets,
      });
      asks.set(askId, { snapshot, log: [], wake: new Set() });
      return { askId };
    },
    async snapshot(askId) {
      return structuredClone(find(askId).snapshot);
    },
    async subscribe(askId, { after = 0, signal }) {
      const ask = find(askId);
      return (async function* () {
        let next = after;
        while (!signal.aborted) {
          const event = ask.log[next];
          if (event) {
            next++;
            yield event;
            if (event.type === 'ask_done') return;
            continue;
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              ask.wake.delete(wake);
              signal.removeEventListener('abort', wake);
              resolve();
            };
            ask.wake.add(wake);
            signal.addEventListener('abort', wake, { once: true });
          });
        }
      })();
    },
    async cancel(askId, slotId) {
      const { snapshot } = find(askId);
      const open = snapshot.slots.filter(
        (slot) =>
          !isTerminalSlotStatus(slot.status) && (slotId === undefined || slot.slotId === slotId),
      );
      for (const slot of open) {
        emit(askId, {
          type: 'cancelled',
          slotId: slot.slotId,
          providerId: slot.providerId,
          elapsedMs: 0,
        });
      }
      return open.map((slot) => slot.slotId);
    },
    async shutdown() {},
  };
}
