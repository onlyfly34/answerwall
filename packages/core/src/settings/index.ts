import { unimplemented } from '../contracts/index.ts';
import type { SecretStore, SettingsService, Storage } from '../contracts/index.ts';

export interface FileSecretStoreOptions {
  /** JSON file with owner-only permissions, separate from the database. */
  file: string;
  /** Read-only overlay, looked up with `secretEnvName`; see `SecretStore`. */
  env: NodeJS.ProcessEnv;
}

export function createFileSecretStore(_options: FileSecretStoreOptions): SecretStore {
  return unimplemented<SecretStore>('secrets');
}

export interface SettingsServiceDeps {
  storage: Storage;
  secrets: SecretStore;
}

export function createSettingsService(_deps: SettingsServiceDeps): SettingsService {
  return unimplemented<SettingsService>('settings', { load: async () => {} });
}
