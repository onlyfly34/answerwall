import type { DeploymentMode } from '../protocol/index.ts';
import type { LogLevel } from './platform.ts';

export type TlsConfig =
  | { mode: 'off' }
  /** PEM files, reloaded when they change. */
  | { mode: 'cert'; certFile: string; keyFile: string }
  /** Private CA and server certificate generated for these DNS names and IP addresses. */
  | { mode: 'auto'; hostnames: string[] };

/**
 * Everything the process is told from outside (environment and flags),
 * already parsed and validated. `apps/server` and the desktop shell build it;
 * core never reads `process.env` for configuration.
 */
export interface AppConfig {
  mode: DeploymentMode;
  /** Reported by `GET /api/meta`. */
  version: string;
  /** Bind address (`<PREFIX>HOST`, default `127.0.0.1`). */
  host: string;
  /** Bind port (`<PREFIX>PORT`); `0` picks a free one. */
  port: number;
  /** Database, secrets, generated certificates and per-request work dirs (`<PREFIX>DATA_DIR`). */
  dataDir: string;
  /** Directory of the built web UI; without it only the API is served. */
  webRoot?: string;
  /** Normalised origins (`scheme://host[:port]`) from `<PREFIX>PUBLIC_ORIGINS`; feeds the Host/Origin allowlist. */
  publicOrigins: string[];
  /** IP addresses and CIDR ranges from `<PREFIX>TRUSTED_PROXIES` whose `X-Forwarded-*` headers are honoured. */
  trustedProxies: string[];
  tls: TlsConfig;
  /** `<PREFIX>ALLOW_INSECURE=1`: permit plain HTTP beyond loopback, with a warning. */
  allowInsecure: boolean;
  /** `<PREFIX>TOKEN`: optional static bearer token for automation, tests and the desktop shell. */
  staticToken?: string;
  logLevel: LogLevel;
}
