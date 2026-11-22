import { BRAND } from '../brand.ts';
import type { Settings, SettingsPatch } from '../protocol/index.ts';

/**
 * Secrets at rest: OpenAI-compatible API keys and TLS private keys. Kept
 * apart from the database. Values never appear in logs or API responses.
 *
 * The server's file store has a read-only environment overlay: the variable
 * {@link secretEnvName}`(key)`, when set and not empty, supplies the secret.
 */
export interface SecretStore {
  /** The environment's value when there is one, else the stored value. */
  get(key: string): Promise<string | undefined>;
  /** @throws AppError `conflict` when the environment supplies this key: the stored value would never be used. */
  set(key: string, value: string): Promise<void>;
  /** Removes the stored value. A value supplied by the environment stays, so `get` may still return one. */
  delete(key: string): Promise<void>;
}

/** Variables with this prefix are secrets for the overlay, not configuration. */
export const SECRET_ENV_PREFIX = `${BRAND.envPrefix}SECRET_`;

/** The environment variable that supplies `key`: upper-cased, every other character replaced by `_`. */
export function secretEnvName(key: string): string {
  return SECRET_ENV_PREFIX + key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * The environment variable that names the one origin (scheme, host, port) an
 * endpoint's API key may be sent to. An API key supplied by the environment
 * is sent only when this is set and matches: whoever holds a session can
 * change an endpoint's address, and must not be able to point an operator's
 * key at a server of their own. A key stored through the API needs no pin;
 * moving its endpoint to another origin deletes it.
 */
export function apiKeyOriginEnvName(providerId: string): string {
  return secretEnvName(`provider.${providerId}.api-key-origin`);
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
  /**
   * The current settings. `hasApiKey` is whether `SecretStore.get` returns a
   * key, wherever it comes from. Never contains a secret.
   */
  get(): Settings;
  /**
   * Validates and applies a partial update, moving API keys into the secret
   * store, then notifies subscribers.
   * @throws AppError `bad_request` | `conflict` (an API key was sent for a
   *   provider whose key comes from the environment)
   */
  update(patch: SettingsPatch): Promise<Settings>;
  /** Calls `listener` after every successful update. Returns the unsubscribe function. */
  subscribe(listener: (settings: Settings) => void): () => void;
}
