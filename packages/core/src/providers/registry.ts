import { AppError } from '../contracts/index.ts';
import type {
  Clock,
  Logger,
  ProviderAdapter,
  ProviderRegistry,
  SettingsService,
} from '../contracts/index.ts';
import {
  KINDS_REQUIRING_ACKNOWLEDGEMENT,
  ModelInfoSchema,
  ProviderDetectionSchema,
  webSearchSupport,
} from '../protocol/index.ts';
import type {
  ModelInfo,
  ProviderDetection,
  ProviderInstance,
  ProviderKind,
  ProviderStatus,
} from '../protocol/index.ts';

export interface RegistryParts {
  settings: SettingsService;
  clock: Clock;
  logger: Logger;
  /** One adapter per kind. */
  adapters: readonly ProviderAdapter[];
  /** Aborting it stops the adapters' detection work; `shutdown()` does so. */
  shutdown: AbortController;
}

interface CacheEntry {
  /** The settings the detection was made with; a later change makes it stale. */
  fingerprint: string;
  detection: ProviderDetection;
  detectedAt: number;
  models: ModelInfo[];
}

const DETECTION_FAILED: ProviderDetection = {
  installed: false,
  loggedIn: 'unknown',
  streaming: 'unknown',
  hint: 'Detection failed unexpectedly.',
};

/** The settings that change what detection would find. */
function fingerprintOf(instance: ProviderInstance): string {
  return JSON.stringify(
    instance.kind === 'openai-compat'
      ? [instance.kind, instance.baseUrl, instance.hasApiKey]
      : [instance.kind, instance.useEnvApiKey, instance.riskAcknowledged],
  );
}

/** A provider behind a vendor notice is never started, not even for detection, before the user accepted it. */
function awaitsAcknowledgement(instance: ProviderInstance): boolean {
  return (
    KINDS_REQUIRING_ACKNOWLEDGEMENT.includes(instance.kind) &&
    !(instance.kind !== 'openai-compat' && instance.riskAcknowledged)
  );
}

function mergeModels(instance: ProviderInstance, listed: ModelInfo[]): ModelInfo[] {
  const own = instance.models
    .filter((id) => !listed.some((model) => model.id === id))
    .map((id): ModelInfo => ({ id }));
  return [...own, ...listed];
}

/**
 * The provider registry: the configured instances joined with a detection
 * cache. The cache is filled only by `refresh()`; `list()` never starts
 * anything.
 */
export function createRegistry(parts: RegistryParts): ProviderRegistry {
  const { settings, clock, logger } = parts;
  const adapters = new Map<ProviderKind, ProviderAdapter>(
    parts.adapters.map((adapter) => [adapter.kind, adapter]),
  );
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<void>>();

  const adapterOf = (kind: ProviderKind): ProviderAdapter => {
    const adapter = adapters.get(kind);
    if (!adapter) throw new Error(`no adapter for ${kind}`);
    return adapter;
  };

  const list = (): ProviderStatus[] => {
    const instances = settings.get().providers;
    for (const id of cache.keys()) {
      if (!instances.some((instance) => instance.id === id)) cache.delete(id);
    }
    return instances.map((instance) => {
      const adapter = adapterOf(instance.kind);
      const cached = cache.get(instance.id);
      const current = cached?.fingerprint === fingerprintOf(instance) ? cached : undefined;
      return {
        instance,
        detection: current?.detection ?? null,
        detectedAt: current?.detectedAt ?? null,
        detecting: inFlight.has(instance.id),
        models: mergeModels(instance, current?.models ?? []),
        toolAccess: adapter.toolAccess,
        webSearch: webSearchSupport(instance.kind),
        ...(adapter.loginCommand === undefined ? {} : { loginCommand: adapter.loginCommand }),
      };
    });
  };

  const detect = async (instance: ProviderInstance): Promise<void> => {
    const adapter = adapterOf(instance.kind);
    let detection = DETECTION_FAILED;
    try {
      const parsed = ProviderDetectionSchema.safeParse(await adapter.detect(instance));
      if (parsed.success) detection = parsed.data;
    } catch (cause) {
      logger.warn('provider detection threw', {
        providerId: instance.id,
        error: cause instanceof Error ? cause.name : 'unknown',
      });
    }
    let models: ModelInfo[] = [];
    if (adapter.listModels && detection.installed && detection.loggedIn !== 'no') {
      try {
        models = (await adapter.listModels(instance)).filter(
          (model) => ModelInfoSchema.safeParse(model).success,
        );
      } catch (cause) {
        logger.warn('provider model listing threw', {
          providerId: instance.id,
          error: cause instanceof Error ? cause.name : 'unknown',
        });
      }
    }
    if (parts.shutdown.signal.aborted) return;
    cache.set(instance.id, {
      fingerprint: fingerprintOf(instance),
      detection,
      detectedAt: clock.now(),
      models,
    });
    logger.info('provider detected', {
      providerId: instance.id,
      installed: detection.installed,
      loggedIn: detection.loggedIn,
      models: models.length,
    });
  };

  /** Concurrent refreshes of one instance share a single detection. */
  const detectOnce = (instance: ProviderInstance): Promise<void> => {
    const running = inFlight.get(instance.id);
    if (running) return running;
    const started = detect(instance).finally(() => inFlight.delete(instance.id));
    inFlight.set(instance.id, started);
    return started;
  };

  return {
    adapter: adapterOf,
    list,
    async refresh(id) {
      const instances = settings.get().providers;
      const targets =
        id === undefined
          ? instances.filter((instance) => instance.enabled)
          : instances.filter((instance) => instance.id === id);
      if (id !== undefined && targets.length === 0) {
        throw new AppError('unknown_provider', `No provider "${id}"`);
      }
      if (!parts.shutdown.signal.aborted) {
        await Promise.all(
          targets.filter((instance) => !awaitsAcknowledgement(instance)).map(detectOnce),
        );
      }
      return list();
    },
    async shutdown() {
      parts.shutdown.abort();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
