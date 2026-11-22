import { AppError } from '../contracts/index.ts';
import type { AskManager, Clock, IdGenerator, SettingsService } from '../contracts/index.ts';
import {
  applyStreamEvent,
  initialAskSnapshot,
  isTerminalSlotStatus,
  isTerminalStreamEvent,
} from '../protocol/index.ts';
import type { AskRequest, AskSnapshot, StreamEvent, WebResultRequest } from '../protocol/index.ts';

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
  /** Every result passed to `submitWebResult`, in order. */
  readonly webResults: { askId: string; slotId: string; result: WebResultRequest }[];
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
  const webResults: FakeAskManager['webResults'] = [];

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
    webResults,
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
        const done = ask.snapshot.status === 'done';
        if (after > ask.log.length || (done && after === ask.log.length)) {
          next = ask.log.length;
          yield {
            type: 'snapshot',
            seq: ask.snapshot.seq,
            snapshot: structuredClone(ask.snapshot),
          } satisfies StreamEvent;
          if (done) return;
        }
        while (!signal.aborted && asks.has(askId)) {
          const event = ask.log[next];
          if (event) {
            next++;
            yield event;
            if (isTerminalStreamEvent(event)) return;
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
    async submitWebResult(askId, slotId, result) {
      const { snapshot } = find(askId);
      const slot = snapshot.slots.find((candidate) => candidate.slotId === slotId);
      if (!slot) throw new AppError('not_found', 'No such slot');
      webResults.push({ askId, slotId, result });
      const base = { slotId, providerId: slot.providerId };
      if (result.outcome === 'done') {
        emit(askId, { type: 'delta', ...base, text: result.text });
        emit(askId, { type: 'done', ...base, elapsedMs: 0 });
        return { status: 'done', truncated: false };
      }
      if (result.outcome === 'failed') {
        emit(askId, {
          type: 'error',
          ...base,
          code: result.code,
          message: result.message ?? '',
          elapsedMs: 0,
        });
        return { status: 'error', truncated: false };
      }
      emit(askId, { type: 'cancelled', ...base, elapsedMs: 0 });
      return { status: 'cancelled', truncated: false };
    },
    forget(askId) {
      const ask = asks.get(askId);
      if (ask?.snapshot.status !== 'done') return;
      asks.delete(askId);
      for (const wake of ask.wake) wake();
    },
    async shutdown() {},
  };
}
