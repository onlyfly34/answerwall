import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { AppError, SECRET_KEYS } from '../contracts/index.ts';
import type { Logger, SecretStore, SettingsService, Storage } from '../contracts/index.ts';
import { createDefaultSettings, SettingsPatchSchema, SettingsSchema } from '../protocol/index.ts';
import type { ProviderInstance, Settings, SettingsPatch } from '../protocol/index.ts';
import { baseUrlIssue, sameOrigin } from './base-url.ts';
import { repairSettings } from './repair.ts';
import type { StoredProvider, StoredSettings } from './repair.ts';

export interface SettingsServiceDeps {
  storage: Storage;
  secrets: SecretStore;
  /** Reports repaired documents and failing subscribers; silent without it. */
  logger?: Logger;
}

type ProviderInputs = NonNullable<SettingsPatch['providers']>;

/** What an update does to the secret store. */
interface SecretPlan {
  /**
   * Changes made before the document is saved, and undone when the save
   * fails. Secret key → new API key, or `undefined` for a key that must be
   * gone before its endpoint's new address takes effect.
   */
  before: Map<string, string | undefined>;
  /** Secret keys whose stored value must go once the document is saved. */
  remove: Set<string>;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.');
  return path ? `${path}: ${issue?.message}` : (issue?.message ?? 'Invalid settings');
}

/** Drops the keys whose value is `undefined`, so a merge cannot erase a field. */
function defined<T extends object>(
  patch: T | undefined,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(patch ?? {}).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function toStored(settings: Settings): StoredSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider): StoredProvider => {
      if (provider.kind !== 'openai-compat') return provider;
      const { hasApiKey: _derived, ...stored } = provider;
      return stored;
    }),
  };
}

/** The document in the API's shape, for validation; `hasApiKey` is a placeholder here. */
const withoutKeys = (stored: StoredSettings): Settings => ({
  ...stored,
  providers: stored.providers.map((provider): ProviderInstance =>
    provider.kind === 'openai-compat' ? { ...provider, hasApiKey: false } : provider,
  ),
});

function planSecrets(inputs: ProviderInputs, before: readonly StoredProvider[]): SecretPlan {
  const plan: SecretPlan = { before: new Map(), remove: new Set() };
  const endpointsBefore = new Map(
    before.flatMap((provider) =>
      provider.kind === 'openai-compat' ? [[provider.id, provider.baseUrl] as const] : [],
    ),
  );
  const kept = new Set(inputs.map((input) => input.id));
  // A removed endpoint takes its key with it.
  for (const id of endpointsBefore.keys()) {
    if (!kept.has(id)) plan.remove.add(SECRET_KEYS.providerApiKey(id));
  }
  for (const input of inputs) {
    if (input.kind !== 'openai-compat') continue;
    const key = SECRET_KEYS.providerApiKey(input.id);
    const previousUrl = endpointsBefore.get(input.id);
    if (typeof input.apiKey === 'string') plan.before.set(key, input.apiKey);
    // A new endpoint must not inherit a key that an earlier one left under its id.
    else if (input.apiKey === null || previousUrl === undefined) plan.remove.add(key);
    // A key belongs to the origin it was entered for. Kept across a move, it
    // would be sent to the new address: a way to read a write-only secret.
    else if (!sameOrigin(previousUrl, input.baseUrl)) plan.before.set(key, undefined);
  }
  return plan;
}

/** The first endpoint address that may not be stored, as a validation message. */
function addressIssue(inputs: ProviderInputs): string | undefined {
  for (const [index, input] of inputs.entries()) {
    if (input.kind !== 'openai-compat') continue;
    const issue = baseUrlIssue(input.baseUrl);
    if (issue) return `providers.${index}.baseUrl: ${issue}`;
  }
  return undefined;
}

function stripApiKeys(inputs: ProviderInputs): StoredProvider[] {
  return inputs.map((input): StoredProvider => {
    if (input.kind !== 'openai-compat') return input;
    const { apiKey: _secret, ...stored } = input;
    return stored;
  });
}

/**
 * Settings live as one JSON document in storage. API keys never enter it:
 * an update moves them into the secret store, and reads expose only whether
 * a key exists.
 */
export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  const { storage, secrets, logger } = deps;
  const listeners = new Set<(settings: Settings) => void>();
  let stored = toStored(createDefaultSettings());
  let current = createDefaultSettings();
  /** Updates run one at a time: each one reads, validates and writes across several awaits. */
  let pending: Promise<unknown> = Promise.resolve();

  const resolve = async (document: StoredSettings): Promise<Settings> => ({
    ...document,
    providers: await Promise.all(
      document.providers.map(async (provider): Promise<ProviderInstance> => {
        if (provider.kind !== 'openai-compat') return provider;
        const key = await secrets.get(SECRET_KEYS.providerApiKey(provider.id));
        return { ...provider, hasApiKey: key !== undefined };
      }),
    ),
  });

  /**
   * Stores the new keys and deletes the ones that must not outlive a move.
   * When a change is refused (a provider's key comes from the environment),
   * the changes already made by this update are put back, so a rejected
   * update changes nothing.
   */
  const changeKeys = async (changes: SecretPlan['before']): Promise<() => Promise<void>> => {
    const previous = new Map<string, string | undefined>();
    const undo = async () => {
      for (const [key, value] of previous) {
        await (value === undefined ? secrets.delete(key) : secrets.set(key, value));
      }
    };
    try {
      for (const [key, value] of changes) {
        const before = await secrets.get(key);
        if (value !== undefined) await secrets.set(key, value);
        else if (before !== undefined) await secrets.delete(key);
        else continue;
        previous.set(key, before);
      }
    } catch (error) {
      await undo();
      throw error;
    }
    return undo;
  };

  const notify = (settings: Settings): void => {
    for (const listener of listeners) {
      try {
        listener(structuredClone(settings));
      } catch (error) {
        // The update is already saved; one subscriber must not fail it or starve the others.
        logger?.error('settings subscriber failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  };

  const apply = async (patch: SettingsPatch): Promise<Settings> => {
    const request = SettingsPatchSchema.safeParse(patch);
    if (!request.success) throw new AppError('bad_request', describeIssue(request.error));
    const { language, providers, limits, layout, updateCheck, webCells } = request.data;
    const refused = providers && addressIssue(providers);
    if (refused) throw new AppError('bad_request', refused);

    const merged = SettingsSchema.safeParse(
      withoutKeys({
        language: language ?? stored.language,
        providers: providers ? stripApiKeys(providers) : stored.providers,
        limits: { ...stored.limits, ...defined(limits) },
        layout: { ...stored.layout, ...defined(layout) },
        updateCheck: updateCheck ?? stored.updateCheck,
        webCells: { ...stored.webCells, ...defined(webCells) },
      }),
    );
    if (!merged.success) throw new AppError('bad_request', describeIssue(merged.error));
    const next = toStored(merged.data);
    const plan: SecretPlan = providers
      ? planSecrets(providers, stored.providers)
      : { before: new Map(), remove: new Set() };

    const undoKeys = await changeKeys(plan.before);
    try {
      await storage.settings.save(next);
    } catch (error) {
      await undoKeys();
      throw error;
    }
    stored = next;
    try {
      for (const key of plan.remove) await secrets.delete(key);
    } finally {
      // Also when a removal failed: the document is saved, and `hasApiKey` must say what is true now.
      current = await resolve(stored);
    }
    notify(current);
    return structuredClone(current);
  };

  return {
    async load() {
      const document = await storage.settings.load();
      if (document === undefined) {
        stored = toStored(createDefaultSettings());
      } else {
        stored = repairSettings(document);
        if (!isDeepStrictEqual(stored, document)) {
          logger?.warn('stored settings were incomplete or invalid and have been repaired');
          await storage.settings.save(stored);
        }
      }
      current = await resolve(stored);
    },

    get: () => structuredClone(current),

    update(patch) {
      const result = pending.then(() => apply(patch));
      pending = result.catch(() => {});
      return result;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
