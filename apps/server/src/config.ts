import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, SECRET_ENV_PREFIX } from '@answerwall/core';
import type { AppConfig, LogLevel, TlsConfig } from '@answerwall/core';
import { SessionRequestSchema } from '@answerwall/core/protocol';

/** A problem with what the operator configured. Its message is shown as is, without a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type LogFormat = 'json' | 'text';

export interface OptionSpec {
  /** The environment variable is `<PREFIX><name>`. */
  readonly name: string;
  /** The command-line flag, without the leading dashes. Absent for values that must not appear in a process list. */
  readonly flag?: string;
  /** A switch takes no value on the command line. */
  readonly kind: 'value' | 'switch';
  /** Placeholder shown in the help text. */
  readonly value?: string;
  readonly description: string;
}

/** Every option the server understands. The help text and the parser are both driven by this table. */
export const OPTIONS = [
  {
    name: 'HOST',
    flag: 'host',
    kind: 'value',
    value: '<address>',
    description: 'Address to bind (default 127.0.0.1).',
  },
  {
    name: 'PORT',
    flag: 'port',
    kind: 'value',
    value: '<port>',
    description: `Port to bind; 0 picks a free one (default ${BRAND.defaultPort}).`,
  },
  {
    name: 'DATA_DIR',
    flag: 'data-dir',
    kind: 'value',
    value: '<dir>',
    description: `Database, secrets and certificates (default ~/.${BRAND.slug}).`,
  },
  {
    name: 'WEB_ROOT',
    flag: 'web-root',
    kind: 'value',
    value: '<dir>',
    description: 'Directory of the built web UI (default: the bundled one).',
  },
  {
    name: 'PUBLIC_ORIGINS',
    flag: 'public-origins',
    kind: 'value',
    value: '<origins>',
    description: 'Comma list of origins browsers use, e.g. https://wall.example.com.',
  },
  {
    name: 'TRUSTED_PROXIES',
    flag: 'trusted-proxies',
    kind: 'value',
    value: '<addresses>',
    description: 'Comma list of proxy IP addresses or CIDR ranges whose X-Forwarded-* is honoured.',
  },
  {
    name: 'TLS',
    flag: 'tls',
    kind: 'value',
    value: 'off|cert|auto',
    description: 'off: plain HTTP (default). cert: PEM files. auto: generated private CA.',
  },
  {
    name: 'TLS_CERT',
    flag: 'tls-cert',
    kind: 'value',
    value: '<file>',
    description: 'PEM certificate chain (TLS mode cert).',
  },
  {
    name: 'TLS_KEY',
    flag: 'tls-key',
    kind: 'value',
    value: '<file>',
    description: 'PEM private key (TLS mode cert).',
  },
  {
    name: 'TLS_HOSTNAMES',
    flag: 'tls-hostnames',
    kind: 'value',
    value: '<names>',
    description:
      'Comma list of DNS names and IP addresses for the generated certificate (TLS mode auto).',
  },
  {
    name: 'ALLOW_INSECURE',
    flag: 'allow-insecure',
    kind: 'switch',
    description: 'Accept plain HTTP from other machines. Unsafe outside a trusted network.',
  },
  {
    name: 'TOKEN',
    kind: 'value',
    description: 'Static bearer token for automation (16 to 512 characters). Environment only.',
  },
  {
    name: 'LOG_LEVEL',
    flag: 'log-level',
    kind: 'value',
    value: 'debug|info|warn|error',
    description: 'Lowest level written to the log (default info).',
  },
  {
    name: 'LOG_FORMAT',
    flag: 'log-format',
    kind: 'value',
    value: 'json|text',
    description: 'Log line format (default: text on a terminal, json otherwise).',
  },
] as const satisfies readonly OptionSpec[];

export type OptionName = (typeof OPTIONS)[number]['name'];

/** Values given on the command line, by option name. They win over the environment. */
export type OptionOverrides = Partial<Record<OptionName, string>>;

export interface ServerSettings {
  config: AppConfig;
  /** `undefined`: the operator did not choose; the caller decides by where the log goes. */
  logFormat: LogFormat | undefined;
}

const envName = (name: string): string => `${BRAND.envPrefix}${name}`;

const TRUE_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LOG_FORMATS: readonly LogFormat[] = ['json', 'text'];
const TLS_MODES = ['off', 'cert', 'auto'] as const;
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);
const DNS_LABELS =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
/** What can travel in an `Authorization` header: visible ASCII without spaces. */
const TOKEN_CHARACTERS = /^[\x21-\x7e]+$/;

/** The version of this package, which is the version of the product. */
export function serverVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

/** The web UI that ships with the server, when it has been built. */
function bundledWebRoot(): string | undefined {
  let manifest: string;
  try {
    manifest = fileURLToPath(import.meta.resolve('@answerwall/web/package.json'));
  } catch {
    return undefined;
  }
  const dist = join(dirname(manifest), 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : undefined;
}

const stripBrackets = (host: string): string => host.replace(/^\[(.*)\]$/, '$1');

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const normalised = value.trim().toLowerCase() as T;
  if (!allowed.includes(normalised)) {
    throw new ConfigError(`${envName(name)} must be one of: ${allowed.join(', ')}`);
  }
  return normalised;
}

/** The compressed lowercase form of an IPv6 literal, as the URL parser writes it. */
const canonicalIpv6 = (literal: string): string =>
  new URL(`http://[${literal}]`).hostname.slice(1, -1);

function parseHost(value: string): string {
  const host = stripBrackets(value.trim()).toLowerCase();
  if (isIP(host) === 6) return canonicalIpv6(host);
  if (isIP(host) === 0 && !DNS_LABELS.test(host)) {
    throw new ConfigError(`${envName('HOST')} must be an IP address or a host name`);
  }
  return host;
}

function parsePort(value: string): number {
  const port = /^\d{1,5}$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new ConfigError(`${envName('PORT')} must be a port number from 0 to 65535`);
  }
  return port;
}

function parseSwitch(name: string, value: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalised)) return true;
  if (FALSE_VALUES.has(normalised)) return false;
  throw new ConfigError(`${envName(name)} must be 1 or 0`);
}

/** `scheme://host[:port]`, lowercase, without a default port. */
function parseOrigin(entry: string): string {
  let url: URL | undefined;
  try {
    url = new URL(entry);
  } catch {
    url = undefined;
  }
  const valid =
    url !== undefined &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    !entry.includes('?') &&
    !entry.includes('#');
  if (!url || !valid) {
    throw new ConfigError(
      `${envName('PUBLIC_ORIGINS')}: "${entry}" is not an origin (expected scheme://host[:port] with http or https)`,
    );
  }
  return url.origin;
}

function parseProxy(entry: string): string {
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  const bits = family === 4 ? 32 : 128;
  const prefixValid =
    prefix === undefined ||
    (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits && rest.length === 0);
  if (family === 0 || !prefixValid) {
    throw new ConfigError(
      `${envName('TRUSTED_PROXIES')}: "${entry}" is not an IP address or CIDR range`,
    );
  }
  return entry;
}

function parseTlsHostname(entry: string): string {
  const name = stripBrackets(entry).toLowerCase();
  if (isIP(name) === 0 && !DNS_LABELS.test(name.replace(/^\*\./, ''))) {
    throw new ConfigError(
      `${envName('TLS_HOSTNAMES')}: "${entry}" is not a DNS name or an IP address`,
    );
  }
  return name;
}

function parseToken(value: string): string {
  const acceptable =
    SessionRequestSchema.shape.token.safeParse(value).success && TOKEN_CHARACTERS.test(value);
  if (!acceptable) {
    // The value itself is never repeated.
    throw new ConfigError(
      `${envName('TOKEN')} must be 16 to 512 visible ASCII characters without spaces`,
    );
  }
  return value;
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const originOf = (scheme: string, host: string, port: number): string =>
  new URL(`${scheme}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`).origin;

/**
 * Reads every option from the environment and the command line and
 * validates them together. Nothing is read from disk except the server's own
 * version and whether a web root holds an `index.html`.
 * @throws ConfigError naming the variable and what is wrong with it; never a secret value.
 */
export function loadSettings(
  env: NodeJS.ProcessEnv,
  overrides: OptionOverrides = {},
): ServerSettings {
  const known: ReadonlySet<string> = new Set(OPTIONS.map((option) => option.name));
  const unknown = Object.keys(env)
    .filter(
      (name) =>
        name.startsWith(BRAND.envPrefix) &&
        // Secrets for the secret store's overlay are not configuration.
        !name.startsWith(SECRET_ENV_PREFIX) &&
        !known.has(name.slice(BRAND.envPrefix.length)),
    )
    .sort();
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
        `Supported: ${OPTIONS.map((option) => envName(option.name)).join(', ')}`,
    );
  }

  /** The command line wins; an empty value counts as not set. */
  const read = (name: OptionName): string | undefined => {
    const value = overrides[name] ?? env[envName(name)];
    return value === undefined || value.trim() === '' ? undefined : value;
  };
  const parsed = <T>(name: OptionName, parse: (value: string) => T): T | undefined => {
    const value = read(name);
    return value === undefined ? undefined : parse(value);
  };

  const host = parsed('HOST', parseHost) ?? '127.0.0.1';
  const port = parsed('PORT', parsePort) ?? BRAND.defaultPort;
  const dataDir = resolve(read('DATA_DIR') ?? join(homedir(), `.${BRAND.slug}`));
  const allowInsecure =
    parsed('ALLOW_INSECURE', (value) => parseSwitch('ALLOW_INSECURE', value)) ?? false;
  const logLevel = parsed('LOG_LEVEL', (value) => oneOf('LOG_LEVEL', value, LOG_LEVELS)) ?? 'info';
  const logFormat = parsed('LOG_FORMAT', (value) => oneOf('LOG_FORMAT', value, LOG_FORMATS));
  const staticToken = parsed('TOKEN', parseToken);
  const trustedProxies = unique(splitList(read('TRUSTED_PROXIES')).map(parseProxy));
  const configuredOrigins = unique(splitList(read('PUBLIC_ORIGINS')).map(parseOrigin));

  const tlsMode = parsed('TLS', (value) => oneOf('TLS', value, TLS_MODES)) ?? 'off';
  const certFile = read('TLS_CERT');
  const keyFile = read('TLS_KEY');
  const tlsHostnames = unique(splitList(read('TLS_HOSTNAMES')).map(parseTlsHostname));
  if (tlsMode !== 'cert' && (certFile !== undefined || keyFile !== undefined)) {
    throw new ConfigError(
      `${envName('TLS_CERT')} and ${envName('TLS_KEY')} are used only with ${envName('TLS')}=cert`,
    );
  }
  if (tlsMode !== 'auto' && tlsHostnames.length > 0) {
    throw new ConfigError(`${envName('TLS_HOSTNAMES')} is used only with ${envName('TLS')}=auto`);
  }

  // The bind address is a name of this server too, unless it is a wildcard or loopback.
  const ownNames = WILDCARD_HOSTS.has(host) || isLoopbackHost(host) ? [] : [host];

  let tls: TlsConfig;
  if (tlsMode === 'cert') {
    if (certFile === undefined || keyFile === undefined) {
      throw new ConfigError(
        `${envName('TLS')}=cert needs both ${envName('TLS_CERT')} and ${envName('TLS_KEY')}`,
      );
    }
    tls = { mode: 'cert', certFile: resolve(certFile), keyFile: resolve(keyFile) };
  } else if (tlsMode === 'auto') {
    const fromOrigins = configuredOrigins
      .map((origin) => new URL(origin))
      .filter((url) => url.protocol === 'https:')
      .map((url) => stripBrackets(url.hostname));
    const hostnames =
      tlsHostnames.length > 0 ? tlsHostnames : unique([...fromOrigins, ...ownNames]);
    tls = { mode: 'auto', hostnames };
  } else {
    tls = { mode: 'off' };
  }

  // Without explicit origins, the names the server knows itself by are reachable on its own port.
  const scheme = tls.mode === 'off' ? 'http' : 'https';
  const derivedNames = unique([
    ...(tls.mode === 'auto' ? tls.hostnames.filter((name) => !name.startsWith('*.')) : []),
    ...ownNames,
  ]).filter((name) => !isLoopbackHost(name));
  const publicOrigins =
    configuredOrigins.length > 0 || port === 0
      ? configuredOrigins
      : unique(derivedNames.map((name) => originOf(scheme, name, port)));

  const explicitWebRoot = read('WEB_ROOT');
  let webRoot: string | undefined;
  if (explicitWebRoot === undefined) {
    webRoot = bundledWebRoot();
  } else {
    webRoot = resolve(explicitWebRoot);
    if (!existsSync(join(webRoot, 'index.html'))) {
      throw new ConfigError(`${envName('WEB_ROOT')} does not contain an index.html`);
    }
  }

  return {
    config: {
      mode: 'server',
      version: serverVersion(),
      host,
      port,
      dataDir,
      publicOrigins,
      trustedProxies,
      tls,
      allowInsecure,
      logLevel,
      ...(webRoot === undefined ? {} : { webRoot }),
      ...(staticToken === undefined ? {} : { staticToken }),
    },
    logFormat,
  };
}

/** The `AppConfig` part of {@link loadSettings}. */
export function loadConfig(env: NodeJS.ProcessEnv, overrides: OptionOverrides = {}): AppConfig {
  return loadSettings(env, overrides).config;
}

/** Whether the bind address keeps the socket on this machine. */
export function bindsLoopback(config: Pick<AppConfig, 'host'>): boolean {
  return isLoopbackHost(config.host);
}

/** Whether the bind address is "every interface". */
export function bindsWildcard(config: Pick<AppConfig, 'host'>): boolean {
  return WILDCARD_HOSTS.has(config.host);
}
