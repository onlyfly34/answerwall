import { Buffer } from 'node:buffer';
import { AppError } from '../contracts/index.ts';
import type {
  AskManager,
  Clock,
  IdGenerator,
  Logger,
  ProviderRegistry,
  SettingsService,
  Storage,
} from '../contracts/index.ts';
import {
  initialAskSnapshot,
  isTerminalSlotStatus,
  SERVER_RESTARTED_ERROR,
} from '../protocol/index.ts';
import type {
  AskRequest,
  AskResponse,
  AskSnapshot,
  ProviderInstance,
  Settings,
  StreamEvent,
} from '../protocol/index.ts';
import type { SlotEventBody } from './events.ts';
import { LiveAsk } from './live-ask.ts';
import { Scheduler } from './scheduler.ts';
import type { Ticket } from './scheduler.ts';
import { executeSlot } from './slot-run.ts';
import type { SlotOutcome } from './slot-run.ts';
import { createWorkDirs, describeError } from './work-dirs.ts';
import type { WorkDirs } from './work-dirs.ts';

/** Internal bounds and intervals; the defaults suit production, tests shrink them. */
export interface AskManagerTuning {
  /** Longest time accumulated text stays unsaved while an ask runs. */
  flushIntervalMs: number;
  /** How long an adapter gets to stop after its slot ended, before its permit is taken back. */
  stopGraceMs: number;
  /** Events retained per ask for replay. */
  logMaxEvents: number;
  /** Text retained per ask for replay, in UTF-16 code units. */
  logMaxChars: number;
  /** Finished asks kept in memory with their event log; older ones are served from storage. */
  finishedAsksRetained: number;
  /** Provider notices passed on per slot; further ones are dropped. */
  maxNoticesPerSlot: number;
}

export const DEFAULT_ASK_MANAGER_TUNING: AskManagerTuning = {
  flushIntervalMs: 1000,
  stopGraceMs: 10_000,
  logMaxEvents: 4096,
  logMaxChars: 1024 * 1024,
  finishedAsksRetained: 8,
  maxNoticesPerSlot: 64,
};

export interface AskManagerDeps {
  storage: Storage;
  settings: SettingsService;
  providers: ProviderRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Directory under which each slot gets its own fresh work dir. The runner owns it entirely. */
  workRoot: string;
  /** Where work dirs come from; by default real directories under `workRoot`. */
  workDirs?: WorkDirs;
  tuning?: Partial<AskManagerTuning>;
}

interface Slot {
  readonly slotId: string;
  readonly providerId: string;
  readonly index: number;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  ticket: Ticket | undefined;
  finished: boolean;
  /** When the slot got its permit; elapsed time counts from here. */
  admittedAt: number | undefined;
  /** Stops the provider and the timeout; set while the slot holds a permit. */
  halt: (() => void) | undefined;
}

interface Ask {
  readonly live: LiveAsk;
  readonly prompt: string;
  readonly slots: Slot[];
  unfinished: number;
  /** Slots changed since the last save. */
  readonly dirty: Set<string>;
  cancelFlush: (() => void) | undefined;
  /** Tail of the ask's serialised saves. */
  saving: Promise<void>;
}

const noSuchAsk = (): AppError => new AppError('not_found', 'No such ask');

/**
 * A stored ask that claims to be unfinished although no run of this process
 * owns it can never finish: it is reported the way `start()` would have left it.
 */
function asInterrupted(stored: AskSnapshot): AskSnapshot {
  if (stored.status === 'done') return stored;
  return {
    ...stored,
    status: 'done',
    slots: stored.slots.map((slot) =>
      isTerminalSlotStatus(slot.status)
        ? slot
        : { ...slot, status: 'error', error: { ...SERVER_RESTARTED_ERROR } },
    ),
  };
}

export function createAskManager(deps: AskManagerDeps): AskManager {
  const { storage, clock, ids } = deps;
  const logger = deps.logger.child({ unit: 'runner' });
  const tuning = { ...DEFAULT_ASK_MANAGER_TUNING, ...deps.tuning };
  const workDirs = deps.workDirs ?? createWorkDirs(deps.workRoot, logger);

  const asks = new Map<string, Ask>();
  /** Finished asks still in memory, oldest first. */
  const retained: string[] = [];
  /** Slot runs and final saves in progress; shutdown waits for them. */
  const tasks = new Set<Promise<void>>();
  let submissions: Promise<unknown> = Promise.resolve();
  let stopped: Promise<void> | undefined;

  let cachedSettings: Settings | undefined;
  const settings = (): Settings => (cachedSettings ??= deps.settings.get());
  const instanceOf = (providerId: string): ProviderInstance | undefined =>
    settings().providers.find((provider) => provider.id === providerId);

  // A provider that is gone or disabled admits everything at once: its queued
  // slots must fail now, not wait for a permit that means nothing any more.
  const scheduler = new Scheduler((providerId) => {
    const instance = instanceOf(providerId);
    return instance?.enabled ? instance.concurrency : Infinity;
  });
  const unsubscribeSettings = deps.settings.subscribe((next) => {
    cachedSettings = next;
    scheduler.dispatch();
  });

  const track = (task: Promise<void>): void => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  // ---- persistence ----

  /** Saves the dirty slots, or everything for the final save; one save per ask at a time. */
  const save = (ask: Ask, final: boolean): Promise<void> => {
    ask.saving = ask.saving.then(async () => {
      const dirty = [...ask.dirty];
      if (!final && dirty.length === 0) return;
      ask.dirty.clear();
      try {
        await storage.turns.save(ask.live.snapshot(), final ? undefined : dirty);
      } catch (error) {
        for (const slotId of dirty) ask.dirty.add(slotId);
        logger.error('could not save an ask', {
          askId: ask.live.askId,
          final,
          error: describeError(error),
        });
      }
    });
    return ask.saving;
  };

  const scheduleFlush = (ask: Ask): void => {
    if (ask.cancelFlush || ask.live.done) return;
    ask.cancelFlush = clock.schedule(tuning.flushIntervalMs, () => {
      ask.cancelFlush = undefined;
      void save(ask, false);
    });
  };

  /** The last save of a finished ask, then history pruning and the memory bound on finished asks. */
  const settle = async (ask: Ask): Promise<void> => {
    await save(ask, true);
    const { historyMaxAsks, historyMaxBytes } = settings().limits;
    try {
      await storage.turns.prune({ maxAsks: historyMaxAsks, maxBytes: historyMaxBytes });
    } catch (error) {
      logger.error('could not prune history', { error: describeError(error) });
    }
    if (asks.get(ask.live.askId) !== ask) return;
    retained.push(ask.live.askId);
    while (retained.length > tuning.finishedAsksRetained) asks.delete(retained.shift()!);
  };

  // ---- events ----

  const emit = (ask: Ask, slot: Slot, body: SlotEventBody): void => {
    ask.live.append({ ...body, slotId: slot.slotId, providerId: slot.providerId });
    ask.dirty.add(slot.slotId);
    scheduleFlush(ask);
  };

  /** The slot's one terminal event; the ask's one `ask_done` after its last slot. */
  const finish = (
    ask: Ask,
    slot: Slot,
    outcome: SlotOutcome | { type: 'cancelled' | 'timeout' },
  ): void => {
    if (slot.finished) return;
    slot.finished = true;
    const measured = slot.admittedAt === undefined ? 0 : clock.now() - slot.admittedAt;
    emit(ask, slot, {
      ...outcome,
      elapsedMs: outcome.type === 'done' ? (outcome.elapsedMs ?? measured) : measured,
    });
    slot.halt?.();
    // A queued slot leaves the queue; an admitted one keeps its permit until its provider is gone.
    if (slot.ticket?.waiting) slot.ticket.release();
    if (--ask.unfinished > 0) return;
    ask.live.append({ type: 'ask_done' });
    ask.cancelFlush?.();
    ask.cancelFlush = undefined;
    track(settle(ask));
  };

  // ---- running ----

  const run = async (ask: Ask, slot: Slot): Promise<void> => {
    const instance = instanceOf(slot.providerId);
    if (!instance?.enabled) {
      finish(ask, slot, {
        type: 'error',
        code: 'unsupported',
        message: `Provider "${slot.providerId}" was disabled or removed before this slot could start.`,
      });
      return;
    }
    const { slotTimeoutMs, maxOutputBytesPerSlot } = settings().limits;
    const abort = new AbortController();
    slot.admittedAt = clock.now();
    const cancelTimeout = clock.schedule(slotTimeoutMs, () =>
      finish(ask, slot, { type: 'timeout' }),
    );
    slot.halt = () => {
      cancelTimeout();
      abort.abort();
    };
    await executeSlot({
      adapter: deps.providers.adapter(instance.kind),
      instance,
      prompt: ask.prompt,
      model: slot.model,
      effort: slot.effort,
      timeoutMs: slotTimeoutMs,
      signal: abort.signal,
      sink: {
        get finished() {
          return slot.finished;
        },
        emit: (event) => emit(ask, slot, event),
        finish: (outcome) => finish(ask, slot, outcome),
      },
      workDirs,
      workDirName: `${ask.live.askId}-${slot.index}`,
      maxOutputBytes: maxOutputBytesPerSlot,
      maxNotices: tuning.maxNoticesPerSlot,
      stopGraceMs: tuning.stopGraceMs,
      detectedStreaming: () =>
        deps.providers.list().find((status) => status.instance.id === slot.providerId)?.detection
          ?.streaming ?? 'unknown',
      clock,
      logger: logger.child({ askId: ask.live.askId, providerId: slot.providerId }),
    });
  };

  /** Called by the scheduler when the slot gets its permit. */
  const admit = (ask: Ask, slot: Slot): void => {
    track(
      run(ask, slot)
        .catch((error: unknown) => {
          logger.error('slot run failed', { askId: ask.live.askId, error: describeError(error) });
          finish(ask, slot, {
            type: 'error',
            code: 'unknown',
            message: 'The slot failed unexpectedly.',
          });
        })
        .finally(() => slot.ticket?.release()),
    );
  };

  // ---- submission ----

  const accept = async (request: AskRequest): Promise<AskResponse> => {
    if (stopped) throw new AppError('conflict', 'The server is shutting down');
    const { limits } = settings();
    if (request.targets.length > limits.maxTargetsPerAsk) {
      throw new AppError(
        'too_many_targets',
        `An ask can have at most ${limits.maxTargetsPerAsk} targets`,
      );
    }
    if (Buffer.byteLength(request.prompt) > limits.maxPromptBytes) {
      throw new AppError(
        'prompt_too_long',
        `The prompt is longer than ${limits.maxPromptBytes} bytes`,
      );
    }
    if (new Set(request.targets.map((target) => target.slotId)).size !== request.targets.length) {
      throw new AppError('bad_request', 'slotId must be unique within an ask');
    }
    const targets = request.targets.map((target) => {
      const instance = instanceOf(target.providerId);
      if (!instance) throw new AppError('unknown_provider', `No provider "${target.providerId}"`);
      if (!instance.enabled) {
        throw new AppError('provider_disabled', `Provider "${target.providerId}" is disabled`);
      }
      const model = target.model ?? instance.defaultModel;
      return {
        slotId: target.slotId,
        providerId: target.providerId,
        kind: instance.kind,
        ...(model === undefined ? {} : { model }),
        ...(target.effort === undefined ? {} : { effort: target.effort }),
      };
    });
    if (
      request.conversationId !== undefined &&
      !(await storage.turns.conversationExists(request.conversationId))
    ) {
      throw new AppError('not_found', 'No such conversation');
    }

    let inFlight = 0;
    for (const ask of asks.values()) if (!ask.live.done) inFlight++;
    if (inFlight >= limits.maxAsksInFlight) {
      throw new AppError(
        'too_many_asks',
        `At most ${limits.maxAsksInFlight} asks can run at the same time`,
      );
    }
    const perProvider = new Map<string, number>();
    for (const target of targets) {
      perProvider.set(target.providerId, (perProvider.get(target.providerId) ?? 0) + 1);
    }
    let wouldWait = 0;
    for (const [providerId, count] of perProvider) {
      wouldWait += Math.max(0, count - scheduler.freePermits(providerId));
    }
    if (wouldWait > 0 && scheduler.waitingCount + wouldWait > limits.maxQueuedSlots) {
      throw new AppError(
        'queue_full',
        `At most ${limits.maxQueuedSlots} slots can wait for a provider`,
      );
    }

    const snapshot = initialAskSnapshot({
      askId: ids.next(),
      conversationId: request.conversationId ?? ids.next(),
      prompt: request.prompt,
      createdAt: clock.now(),
      targets,
    });
    await storage.turns.create(snapshot);
    // Stored but never run: the next start reports it as interrupted.
    if (stopped) throw new AppError('conflict', 'The server is shutting down');

    const ask: Ask = {
      live: new LiveAsk(snapshot, {
        maxEvents: tuning.logMaxEvents,
        maxChars: tuning.logMaxChars,
      }),
      prompt: request.prompt,
      slots: targets.map((target, index) => ({
        slotId: target.slotId,
        providerId: target.providerId,
        index,
        model: target.model,
        effort: target.effort,
        ticket: undefined,
        finished: false,
        admittedAt: undefined,
        halt: undefined,
      })),
      unfinished: targets.length,
      dirty: new Set(),
      cancelFlush: undefined,
      saving: Promise.resolve(),
    };
    asks.set(snapshot.askId, ask);
    for (const slot of ask.slots) {
      slot.ticket = scheduler.enqueue(slot.providerId, snapshot.askId, () => admit(ask, slot));
    }
    for (const providerId of perProvider.keys()) scheduler.dispatch(providerId);
    for (const slot of ask.slots) if (slot.ticket?.waiting) emit(ask, slot, { type: 'queued' });
    logger.info('ask accepted', { askId: snapshot.askId, slots: ask.slots.length });
    return { askId: snapshot.askId };
  };

  const stored = async (askId: string): Promise<AskSnapshot> => {
    const snapshot = await storage.turns.get(askId);
    if (!snapshot) throw noSuchAsk();
    return asInterrupted(snapshot);
  };

  const shutdown = async (): Promise<void> => {
    unsubscribeSettings();
    // A submission caught between its checks and its first slot ends first.
    await submissions.catch(() => {});
    for (const ask of asks.values()) {
      for (const slot of ask.slots) finish(ask, slot, { type: 'error', ...SERVER_RESTARTED_ERROR });
    }
    while (tasks.size > 0) await Promise.allSettled([...tasks]);
    await Promise.allSettled([...asks.values()].map((ask) => ask.saving));
    // Last: until here this process still had children in the work dirs.
    await workDirs.release();
  };

  return {
    async start() {
      // First: everything below assumes that no other process is running asks
      // on this data directory. A second server would otherwise fail the
      // first one's running slots and delete the directories of its children.
      await workDirs.claim();
      try {
        const failed = await storage.turns.failInterrupted(SERVER_RESTARTED_ERROR);
        if (failed > 0) logger.warn('failed slots interrupted by a previous process', { failed });
        await workDirs.reset();
      } catch (error) {
        await workDirs.release();
        throw error;
      }
    },

    submit(request) {
      // One at a time, so the limits are checked against what is really admitted.
      const result = submissions.then(
        () => accept(request),
        () => accept(request),
      );
      submissions = result;
      return result;
    },

    async snapshot(askId) {
      return asks.get(askId)?.live.snapshot() ?? stored(askId);
    },

    async subscribe(askId, { after = 0, signal }) {
      const ask = asks.get(askId);
      if (ask) return ask.live.subscribe(after, signal);
      const snapshot = await stored(askId);
      return (async function* (): AsyncGenerator<StreamEvent, void, void> {
        if (!signal.aborted) yield { type: 'snapshot', seq: snapshot.seq, snapshot };
      })();
    },

    async cancel(askId, slotId) {
      const ask = asks.get(askId);
      if (!ask) {
        await stored(askId);
        return [];
      }
      const open = ask.slots.filter(
        (slot) => !slot.finished && (slotId === undefined || slot.slotId === slotId),
      );
      for (const slot of open) finish(ask, slot, { type: 'cancelled' });
      return open.map((slot) => slot.slotId);
    },

    forget(askId) {
      const ask = asks.get(askId);
      if (!ask?.live.done) return;
      asks.delete(askId);
      const index = retained.indexOf(askId);
      if (index >= 0) retained.splice(index, 1);
      ask.live.close();
    },

    shutdown() {
      return (stopped ??= shutdown());
    },
  };
}
