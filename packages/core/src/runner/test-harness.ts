import { join } from 'node:path';
import type { AskManager, ProviderAdapter, ProviderRegistry, Storage } from '../contracts/index.ts';
import { applyStreamEvent, createDefaultSettings } from '../protocol/index.ts';
import type {
  AskSnapshot,
  AskTarget,
  ProviderKind,
  Settings,
  StreamEvent,
} from '../protocol/index.ts';
import {
  createFakeProviderRegistry,
  createFakeSettingsService,
  createFakeStorage,
  createMemoryLogger,
  createSequentialIds,
  FakeClock,
  FakeProviderAdapter,
  flushPromises,
} from '../testing/index.ts';
import type { FakeAdapterOptions } from '../testing/index.ts';
import { createAskManager } from './index.ts';
import type { AskManagerTuning } from './index.ts';
import type { WorkDirs } from './work-dirs.ts';

/** `WorkDirs` without a file system, so a test advances only on the fake clock. */
export interface MemoryWorkDirs extends WorkDirs {
  /** Directories that exist right now. */
  readonly existing: Set<string>;
  /** Every directory ever created, in order. */
  readonly created: string[];
  /** While set, `create` fails. */
  failCreate: boolean;
}

export function createMemoryWorkDirs(): MemoryWorkDirs {
  const existing = new Set<string>();
  const created: string[] = [];
  return {
    existing,
    created,
    failCreate: false,
    async claim() {},
    async release() {},
    async reset() {
      existing.clear();
    },
    async create(name) {
      if (this.failCreate) throw new Error('no space left');
      const dir = join('work', name);
      existing.add(dir);
      created.push(dir);
      return dir;
    },
    async remove(dir) {
      existing.delete(dir);
    },
  };
}

export interface HarnessOptions {
  /** Changes the default settings before the manager is built. */
  settings?: (settings: Settings) => void;
  /** The script of the default adapters; see `FakeProviderAdapter`. */
  script?: FakeAdapterOptions['script'];
  /** Replace the default adapter of their kind. */
  adapters?: ProviderAdapter[];
  storage?: Storage;
  tuning?: Partial<AskManagerTuning>;
  /** Real directories under this root instead of the in-memory ones. */
  workRoot?: string;
}

/** A live subscription that records what it receives. */
export interface Watch {
  readonly events: StreamEvent[];
  /** Resolves when the iteration has ended. */
  readonly ended: Promise<void>;
  stop(): void;
}

export interface Harness {
  manager: AskManager;
  clock: FakeClock;
  storage: Storage;
  settings: ReturnType<typeof createFakeSettingsService>;
  providers: ProviderRegistry;
  logger: ReturnType<typeof createMemoryLogger>;
  workDirs: MemoryWorkDirs;
  claude: FakeProviderAdapter;
  codex: FakeProviderAdapter;
  grok: FakeProviderAdapter;
  /** The adapter of every OpenAI-compatible endpoint. */
  compat: FakeProviderAdapter;
  /** Submits a prompt to the given targets and lets the admitted slots reach their adapters. */
  ask(targets: AskTarget[], prompt?: string): Promise<string>;
  /** Every event of a subscription that ends by itself. */
  events(askId: string, after?: number): Promise<StreamEvent[]>;
  watch(askId: string, after?: number): Watch;
  /** Lets every pending promise callback run. */
  settle(): Promise<void>;
}

/** `count` targets for one provider with slot ids `<prefix>1`, `<prefix>2`, … */
export function targets(
  providerId: string,
  count: number,
  prefix = providerId[0]!,
  extra: Partial<AskTarget> = {},
): AskTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    slotId: `${prefix}${index + 1}`,
    providerId,
    ...extra,
  }));
}

/** The snapshot a client ends up with after applying these events to `initial`. */
export function fold(initial: AskSnapshot, events: readonly StreamEvent[]): AskSnapshot {
  return events.reduce(applyStreamEvent, structuredClone(initial));
}

/** The real manager over the in-memory fakes, driven by a fake clock. */
export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const initial = createDefaultSettings();
  options.settings?.(initial);
  const settings = createFakeSettingsService(initial);
  const storage = options.storage ?? createFakeStorage();
  const logger = createMemoryLogger();
  const workDirs = createMemoryWorkDirs();
  const scripted = (kind: ProviderKind): FakeProviderAdapter =>
    new FakeProviderAdapter({
      kind,
      clock,
      ...(options.script === undefined ? {} : { script: options.script }),
    });
  const claude = scripted('claude');
  const codex = scripted('codex');
  const grok = scripted('grok');
  const compat = scripted('openai-compat');
  const providers = createFakeProviderRegistry({
    settings,
    clock,
    adapters: [claude, codex, grok, compat, ...(options.adapters ?? [])],
  });
  const manager = createAskManager({
    storage,
    settings,
    providers,
    clock,
    ids: createSequentialIds('ask'),
    logger,
    workRoot: options.workRoot ?? 'unused',
    ...(options.workRoot === undefined ? { workDirs } : {}),
    ...(options.tuning === undefined ? {} : { tuning: options.tuning }),
  });

  const watch = (askId: string, after?: number): Watch => {
    const abort = new AbortController();
    const events: StreamEvent[] = [];
    const ended = (async () => {
      const stream = await manager.subscribe(askId, {
        ...(after === undefined ? {} : { after }),
        signal: abort.signal,
      });
      for await (const event of stream) events.push(event);
    })();
    return { events, ended, stop: () => abort.abort() };
  };

  return {
    manager,
    clock,
    storage,
    settings,
    providers,
    logger,
    workDirs,
    claude,
    codex,
    grok,
    compat,
    async ask(askTargets, prompt = 'What is 2 + 2?') {
      const { askId } = await manager.submit({ prompt, targets: askTargets });
      await flushPromises();
      return askId;
    },
    async events(askId, after) {
      const subscription = watch(askId, after);
      await subscription.ended;
      return subscription.events;
    },
    watch,
    settle: flushPromises,
  };
}
