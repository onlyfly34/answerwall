import type { TlsMode } from '../protocol/index.ts';

export interface TlsMaterial {
  /** PEM, leaf first. */
  cert: string;
  /** PEM. */
  key: string;
}

export interface TlsProvider {
  readonly mode: TlsMode;
  /**
   * Certificate and key to serve with; `null` in `off` mode. In `auto` mode
   * the first call generates and persists the CA and server certificate.
   */
  material(): Promise<TlsMaterial | null>;
  /** Fires with fresh material when the certificate files changed (`cert` mode). */
  onChange(listener: (material: TlsMaterial) => void): () => void;
  /** PEM of the private CA for clients to install; `null` unless the mode is `auto`. */
  caCertificatePem(): Promise<string | null>;
  /** Stops watching files. */
  close(): Promise<void>;
}
