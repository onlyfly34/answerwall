import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, SECRET_ENV_PREFIX } from '@answerwall/core';
import type { AppConfig } from '@answerwall/core';

/** Scaffold: the only variables understood so far. Any other prefixed variable is refused. */
const SUPPORTED = ['HOST', 'PORT', 'DATA_DIR'];

function ownVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

/** The built web UI, when it has been built. */
function findWebRoot(): string | undefined {
  const manifest = fileURLToPath(import.meta.resolve('@answerwall/web/package.json'));
  const dist = join(dirname(manifest), 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const unsupported = Object.keys(env).filter(
    (name) =>
      name.startsWith(BRAND.envPrefix) &&
      // Secrets for the secret store's overlay are not configuration.
      !name.startsWith(SECRET_ENV_PREFIX) &&
      !SUPPORTED.includes(name.slice(BRAND.envPrefix.length)),
  );
  if (unsupported.length > 0) {
    throw new Error(`Not supported yet: ${unsupported.join(', ')}`);
  }
  const read = (name: string) => env[`${BRAND.envPrefix}${name}`];

  const port = Number(read('PORT') ?? BRAND.defaultPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${BRAND.envPrefix}PORT must be a port number`);
  }
  const webRoot = findWebRoot();

  return {
    mode: 'server',
    version: ownVersion(),
    host: read('HOST') ?? '127.0.0.1',
    port,
    dataDir: resolve(read('DATA_DIR') ?? `.${BRAND.slug}`),
    publicOrigins: [],
    trustedProxies: [],
    tls: { mode: 'off' },
    allowInsecure: false,
    logLevel: 'info',
    ...(webRoot === undefined ? {} : { webRoot }),
  };
}
