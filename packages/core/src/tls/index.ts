import { NotImplementedError } from '../contracts/index.ts';
import type { AppConfig, Logger, SecretStore, TlsProvider } from '../contracts/index.ts';

export interface TlsProviderDeps {
  config: AppConfig;
  /** Holds the generated private keys in `auto` mode. */
  secrets: SecretStore;
  logger: Logger;
}

export function createTlsProvider({ config }: TlsProviderDeps): TlsProvider {
  return {
    mode: config.tls.mode,
    material: () =>
      config.tls.mode === 'off'
        ? Promise.resolve(null)
        : Promise.reject(new NotImplementedError(`tls mode "${config.tls.mode}"`)),
    onChange: () => () => {},
    caCertificatePem: () => Promise.resolve(null),
    close: () => Promise.resolve(),
  };
}
