import { join } from 'node:path';
import type {
  AppConfig,
  Clock,
  Logger,
  RandomSource,
  SecretStore,
  TlsProvider,
} from '../contracts/index.ts';
import { systemClock, systemRandom } from '../system.ts';
import { createAutoTlsProvider } from './auto.ts';
import { createCertFilesProvider } from './cert-files.ts';

/** Subdirectory of the data directory that holds the generated certificates. */
export const TLS_DIRECTORY = 'tls';

export interface TlsProviderDeps {
  config: AppConfig;
  /** Holds the generated private keys in `auto` mode. */
  secrets: SecretStore;
  logger: Logger;
  /** Times reloads and renewals; the system clock by default. */
  clock?: Clock;
  /** Certificate serial numbers; the system's randomness by default. */
  random?: RandomSource;
}

const offProvider: TlsProvider = {
  mode: 'off',
  material: async () => null,
  onChange: () => () => {},
  caCertificatePem: async () => null,
  close: async () => {},
};

/** Picks the provider for `config.tls.mode`. Nothing is read or generated before `material()`. */
export function createTlsProvider(deps: TlsProviderDeps): TlsProvider {
  const { config, secrets, logger } = deps;
  const clock = deps.clock ?? systemClock;
  switch (config.tls.mode) {
    case 'off':
      return offProvider;
    case 'cert':
      return createCertFilesProvider({
        certFile: config.tls.certFile,
        keyFile: config.tls.keyFile,
        logger,
        clock,
      });
    case 'auto':
      return createAutoTlsProvider({
        hostnames: config.tls.hostnames,
        directory: join(config.dataDir, TLS_DIRECTORY),
        secrets,
        logger,
        clock,
        random: deps.random ?? systemRandom,
      });
  }
}
