import { unimplemented } from '../contracts/index.ts';
import type {
  Clock,
  Logger,
  ProviderRegistry,
  SecretStore,
  SettingsService,
} from '../contracts/index.ts';

export interface ProviderRegistryDeps {
  settings: SettingsService;
  /** API keys of OpenAI-compatible endpoints. */
  secrets: SecretStore;
  clock: Clock;
  logger: Logger;
  /** The environment child processes start from, before scrubbing. */
  env: NodeJS.ProcessEnv;
}

export function createProviderRegistry(_deps: ProviderRegistryDeps): ProviderRegistry {
  return unimplemented<ProviderRegistry>('providers', { shutdown: async () => {} });
}
