import { AppError } from '../contracts/index.ts';
import type {
  Clock,
  ProviderAdapter,
  ProviderEvent,
  ProviderRegistry,
  RunRequest,
  SettingsService,
} from '../contracts/index.ts';
import { PROVIDER_KINDS, webSearchSupport } from '../protocol/index.ts';
import type {
  ModelInfo,
  ProviderDetection,
  ProviderInstance,
  ProviderKind,
  ProviderStatus,
  ToolAccess,
} from '../protocol/index.ts';

/**
 * One step of a scripted run: wait `delayMs` on the clock, then yield
 * `event`; or `hang`, which waits until the request is aborted.
 */
export type ScriptStep = { event: ProviderEvent; delayMs?: number } | { hang: true };

export interface FakeAdapterOptions {
  kind: ProviderKind;
  clock: Clock;
  /** The script of every run, or a function choosing one per request. */
  script?: ScriptStep[] | ((request: RunRequest, instance: ProviderInstance) => ScriptStep[]);
  detection?: ProviderDetection;
  models?: ModelInfo[];
  toolAccess?: ToolAccess;
}

export const READY_DETECTION: ProviderDetection = {
  installed: true,
  version: '1.0.0',
  loggedIn: 'yes',
  billing: 'subscription',
  streaming: 'token',
};

/** `start`, the given text deltas, then `done`. */
export function answerScript(deltas: string[], delayMs = 0): ScriptStep[] {
  return [
    { event: { type: 'start' } },
    ...deltas.map((text): ScriptStep => ({ event: { type: 'delta', text }, delayMs })),
    { event: { type: 'done', elapsedMs: delayMs * deltas.length }, delayMs },
  ];
}

function waitOrAbort(clock: Clock, delayMs: number | undefined, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const cancel = delayMs === undefined ? undefined : clock.schedule(delayMs, done);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      cancel?.();
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * A `ProviderAdapter` that replays a script on the given clock, stops as soon
 * as the request is aborted, and records every request it received.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly toolAccess: ToolAccess;
  readonly runs: { instance: ProviderInstance; request: RunRequest }[] = [];
  detection: ProviderDetection;
  detectCalls = 0;
  /** Number of runs that have started and not yet ended. */
  active = 0;
  private readonly options: FakeAdapterOptions;

  constructor(options: FakeAdapterOptions) {
    this.options = options;
    this.kind = options.kind;
    this.toolAccess = options.toolAccess ?? 'none';
    this.detection = options.detection ?? READY_DETECTION;
  }

  async detect(): Promise<ProviderDetection> {
    this.detectCalls++;
    return this.detection;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.options.models ?? [];
  }

  async *run(instance: ProviderInstance, request: RunRequest): AsyncIterable<ProviderEvent> {
    this.runs.push({ instance, request });
    const { script = answerScript(['ok']), clock } = this.options;
    const steps = typeof script === 'function' ? script(request, instance) : script;
    this.active++;
    try {
      for (const step of steps) {
        if ('hang' in step) await waitOrAbort(clock, undefined, request.signal);
        else if (step.delayMs) await waitOrAbort(clock, step.delayMs, request.signal);
        if (request.signal.aborted) return;
        if ('event' in step) yield step.event;
      }
    } finally {
      this.active--;
    }
  }
}

/**
 * A `ProviderRegistry` over the given adapters (kinds without one get a
 * default `FakeProviderAdapter`). Nothing is detected until `refresh()`.
 */
export function createFakeProviderRegistry(deps: {
  settings: SettingsService;
  clock: Clock;
  adapters?: ProviderAdapter[];
}): ProviderRegistry {
  const adapters = new Map<ProviderKind, ProviderAdapter>(
    PROVIDER_KINDS.map((kind) => [kind, new FakeProviderAdapter({ kind, clock: deps.clock })]),
  );
  for (const adapter of deps.adapters ?? []) adapters.set(adapter.kind, adapter);
  const detected = new Map<string, Pick<ProviderStatus, 'detection' | 'detectedAt' | 'models'>>();

  const adapterOf = (kind: ProviderKind): ProviderAdapter => {
    const adapter = adapters.get(kind);
    if (!adapter) throw new Error(`no adapter for ${kind}`);
    return adapter;
  };

  const list = (): ProviderStatus[] =>
    deps.settings.get().providers.map((instance) => {
      const adapter = adapterOf(instance.kind);
      const cached = detected.get(instance.id);
      const listed = cached?.models ?? [];
      const own = instance.models
        .filter((id) => !listed.some((model) => model.id === id))
        .map((id) => ({ id }));
      return {
        instance,
        detection: cached?.detection ?? null,
        detectedAt: cached?.detectedAt ?? null,
        models: [...own, ...listed],
        toolAccess: adapter.toolAccess,
        webSearch: webSearchSupport(instance.kind),
        ...(adapter.loginCommand === undefined ? {} : { loginCommand: adapter.loginCommand }),
      };
    });

  return {
    adapter: adapterOf,
    list,
    async refresh(id) {
      const instances = deps.settings.get().providers;
      const targets =
        id === undefined
          ? instances.filter((p) => p.enabled)
          : instances.filter((p) => p.id === id);
      if (id !== undefined && targets.length === 0) {
        throw new AppError('unknown_provider', `No provider "${id}"`);
      }
      for (const instance of targets) {
        const adapter = adapterOf(instance.kind);
        detected.set(instance.id, {
          detection: await adapter.detect(instance),
          detectedAt: deps.clock.now(),
          models: (await adapter.listModels?.(instance)) ?? [],
        });
      }
      return list();
    },
    async shutdown() {},
  };
}
