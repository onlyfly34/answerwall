import { AppError, SECRET_KEYS } from '../contracts/index.ts';
import type { SecretStore, SettingsService } from '../contracts/index.ts';
import { createDefaultSettings, SettingsSchema } from '../protocol/index.ts';
import type { ProviderInstance, Settings, SettingsPatch } from '../protocol/index.ts';
import { createFakeSecretStore } from './storage.ts';

/**
 * In-memory `SettingsService`: applies patches with the documented merge
 * rules and keeps API keys in the given secret store, but persists nothing.
 */
export function createFakeSettingsService(
  initial: Settings = createDefaultSettings(),
  secrets: SecretStore = createFakeSecretStore(),
): SettingsService {
  let current = structuredClone(initial);
  const listeners = new Set<(settings: Settings) => void>();

  const applyProviders = async (
    inputs: NonNullable<SettingsPatch['providers']>,
  ): Promise<ProviderInstance[]> => {
    const kept = new Set(inputs.map((input) => input.id));
    for (const removed of current.providers.filter((p) => !kept.has(p.id))) {
      await secrets.delete(SECRET_KEYS.providerApiKey(removed.id));
    }
    const result: ProviderInstance[] = [];
    for (const input of inputs) {
      if (input.kind !== 'openai-compat') {
        result.push(input);
        continue;
      }
      const { apiKey, ...instance } = input;
      const key = SECRET_KEYS.providerApiKey(input.id);
      if (apiKey === null) await secrets.delete(key);
      else if (apiKey !== undefined) await secrets.set(key, apiKey);
      result.push({ ...instance, hasApiKey: (await secrets.get(key)) !== undefined });
    }
    return result;
  };

  return {
    async load() {},
    get: () => structuredClone(current),
    async update(patch) {
      const merged = SettingsSchema.safeParse({
        language: patch.language ?? current.language,
        providers: patch.providers ? await applyProviders(patch.providers) : current.providers,
        limits: { ...current.limits, ...patch.limits },
        layout: { ...current.layout, ...patch.layout },
        updateCheck: patch.updateCheck ?? current.updateCheck,
      });
      if (!merged.success) {
        throw new AppError('bad_request', merged.error.issues[0]?.message ?? 'Invalid settings');
      }
      current = merged.data;
      for (const listener of listeners) listener(structuredClone(current));
      return structuredClone(current);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
