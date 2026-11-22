import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, secretEnvName } from '../contracts/index.ts';
import type { SecretStore } from '../contracts/index.ts';

export interface FileSecretStoreOptions {
  /** JSON file with owner-only permissions, separate from the database. */
  file: string;
  /** Read-only overlay, looked up with `secretEnvName`; see `SecretStore`. */
  env: NodeJS.ProcessEnv;
}

const OWNER_ONLY = 0o600;
const FORMAT_VERSION = 1;
/** Mode bits mean nothing on Windows; see `createFileSecretStore`. */
const HAS_MODE_BITS = process.platform !== 'win32';

/** Windows refuses to replace a file that a scanner or indexer has open; such locks last milliseconds. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 10;

type Secrets = Map<string, string>;

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/** Never includes file content: a damaged file may still hold readable secrets. */
function damaged(): Error {
  return new Error('The secret store file is damaged; repair or remove it');
}

function parseSecrets(json: string): Secrets {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw damaged();
  }
  const secrets =
    typeof document === 'object' && document !== null && 'secrets' in document
      ? document.secrets
      : undefined;
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) throw damaged();
  const entries = Object.entries(secrets);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    throw damaged();
  }
  return new Map(entries);
}

async function readSecrets(file: string): Promise<Secrets> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return new Map();
    throw error;
  }
  try {
    // Someone may have copied or restored the file with wider permissions.
    if (HAS_MODE_BITS && ((await handle.stat()).mode & 0o077) !== 0) {
      await handle.chmod(OWNER_ONLY);
    }
    return parseSecrets(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retry = !HAS_MODE_BITS && RENAME_RETRY_CODES.has(errorCode(error) ?? '');
      if (!retry || attempt === RENAME_ATTEMPTS) throw error;
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Writes the whole file under a temporary name and renames it into place, so
 * a crash leaves either the old content or the new, never a partial file.
 * The temporary file is created owner-only before any secret is written.
 */
async function writeSecrets(file: string, secrets: Secrets, temporary: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const json = JSON.stringify(
    { version: FORMAT_VERSION, secrets: Object.fromEntries(secrets) },
    null,
    2,
  );
  try {
    // A crash may have left a file under this name; `wx` then guarantees the
    // file written to is one created here, with this mode.
    await rm(temporary, { force: true });
    const handle = await open(temporary, 'wx', OWNER_ONLY);
    try {
      await handle.writeFile(`${json}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The creation mode is narrowed by the umask but never widened; this
    // also covers a umask that removes the owner's own bits.
    if (HAS_MODE_BITS) await chmod(temporary, OWNER_ONLY);
    await replaceFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Secrets in one JSON file next to (never inside) the database.
 *
 * Protection at rest: on POSIX systems the file has mode `0600`, so only the
 * account running the server can read it. On Windows mode bits do not exist;
 * the file is protected by the access control list it inherits from the data
 * directory, which is why the data directory belongs in the user's profile
 * (or another directory only that account can read).
 *
 * The environment overlay is read-only: a non-empty variable
 * `secretEnvName(key)` wins over the stored value and cannot be replaced
 * through `set`. Values are never logged and never appear in error messages.
 *
 * The file is read on every `get`, so nothing is kept in memory between
 * calls; writes are serialised within this process. Only one process writes
 * the file (the server); the `pair` command never touches it.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  const { file, env } = options;
  let writes: Promise<void> = Promise.resolve();
  let temporaryFiles = 0;

  const fromEnvironment = (key: string): string | undefined => {
    const value = env[secretEnvName(key)];
    return value === undefined || value === '' ? undefined : value;
  };

  /** Runs `change` on the stored secrets after every earlier write has finished. */
  const mutate = (change: (secrets: Secrets) => boolean): Promise<void> => {
    const result = writes.then(async () => {
      const secrets = await readSecrets(file);
      if (!change(secrets)) return;
      await writeSecrets(file, secrets, `${file}.${process.pid}.${++temporaryFiles}.tmp`);
    });
    // A failed write is reported to its caller and must not fail the next one.
    writes = result.catch(() => {});
    return result;
  };

  return {
    async get(key) {
      return fromEnvironment(key) ?? (await readSecrets(file)).get(key);
    },

    async set(key, value) {
      if (value === '') throw new AppError('bad_request', 'A secret cannot be empty');
      if (fromEnvironment(key) !== undefined) {
        throw new AppError(
          'conflict',
          `This value is supplied by the environment variable ${secretEnvName(key)} and cannot be changed here`,
        );
      }
      await mutate((secrets) => {
        if (secrets.get(key) === value) return false;
        secrets.set(key, value);
        return true;
      });
    },

    async delete(key) {
      await mutate((secrets) => secrets.delete(key));
    },
  };
}
