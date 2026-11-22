import { unimplemented } from '../contracts/index.ts';
import type {
  AuthService,
  Clock,
  IdGenerator,
  Logger,
  RandomSource,
  Storage,
} from '../contracts/index.ts';

export { requireAuth } from './middleware.ts';

export interface AuthServiceDeps {
  storage: Storage;
  clock: Clock;
  ids: IdGenerator;
  random: RandomSource;
  logger: Logger;
  staticToken: string | undefined;
}

export function createAuthService(_deps: AuthServiceDeps): AuthService {
  return unimplemented<AuthService>('auth', { bootstrap: async () => {} });
}
