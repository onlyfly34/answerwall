import type { Settings, SettingsPatch } from '../protocol/index.ts';

/**
 * Secrets at rest: OpenAI-compatible API keys and TLS private keys. Kept
 * apart from the database. Values never appear in logs or API responses.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The keys used with {@link SecretStore}. */
export const SECRET_KEYS = {
  providerApiKey: (providerId: string) => `provider.${providerId}.api-key`,
  tlsCaKey: 'tls.ca.key',
  tlsServerKey: 'tls.server.key',
} as const;

export interface SettingsService {
  /** Reads the stored settings (defaults on first run). Called once before first use. */
  load(): Promise<void>;
  /** The current settings; `hasApiKey` reflects the secret store. Never contains a secret. */
  get(): Settings;
  /**
   * Validates and applies a partial update, moving API keys into the secret
   * store, then notifies subscribers.
   * @throws AppError `bad_request`
   */
  update(patch: SettingsPatch): Promise<Settings>;
  /** Calls `listener` after every successful update. Returns the unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void;
}
