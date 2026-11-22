import { unimplemented } from '../contracts/index.ts';
import type {
  AskManager,
  Clock,
  IdGenerator,
  Logger,
  ProviderRegistry,
  SettingsService,
  Storage,
} from '../contracts/index.ts';

export interface AskManagerDeps {
  storage: Storage;
  settings: SettingsService;
  providers: ProviderRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Directory under which each slot gets its own fresh work dir. */
  workRoot: string;
}

export function createAskManager(_deps: AskManagerDeps): AskManager {
  return unimplemented<AskManager>('runner', {
    start: async () => {},
    shutdown: async () => {},
  });
}
