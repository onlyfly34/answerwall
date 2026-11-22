/**
 * The desktop secret store. The core server runs in a utility process, where
 * the operating system's encryption (Electron `safeStorage`: DPAPI on
 * Windows) is not available, so the store lives here in the main process and
 * the core host reaches it through messages.
 *
 * On disk: a JSON file mapping each key to the encrypted value, base64. A
 * value is never written in plain text and never logged; error messages
 * carry neither values nor file content.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The part of `safeStorage` the store uses. */
export interface Cipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  /** @throws when the data was not encrypted by this user on this computer */
  decrypt(data: Buffer): string;
}

export interface SecretFiles {
  read(file: string): Promise<string | undefined>;
  write(file: string, content: string): Promise<void>;
}

export const secretDiskFiles: SecretFiles = {
  async read(file) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('The secret store file cannot be read', { cause: error });
    }
  },
  async write(file, content) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  },
};

/** Thrown by `set` when the system offers no encryption; nothing is stored then. */
export class SecretsUnavailableError extends Error {
  constructor() {
    super('The operating system offers no encryption for secrets');
    this.name = 'SecretsUnavailableError';
  }
}

export interface EncryptedSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type Entries = Record<string, string>;

function parseEntries(json: string | undefined): Entries {
  if (json === undefined) return {};
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new Error('The secret store file is damaged; repair or remove it');
  }
  const secrets =
    typeof document === 'object' && document !== null && 'secrets' in document
      ? document.secrets
      : undefined;
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
    throw new Error('The secret store file is damaged; repair or remove it');
  }
  const entries: Entries = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === 'string') entries[key] = value;
  }
  return entries;
}

export function createEncryptedSecretStore(options: {
  file: string;
  cipher: Cipher;
  files?: SecretFiles;
}): EncryptedSecretStore {
  const { file, cipher } = options;
  const files = options.files ?? secretDiskFiles;

  /** Reads and writes run one after the other, so two changes cannot lose one another. */
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  const load = async (): Promise<Entries> => parseEntries(await files.read(file));
  const save = (entries: Entries): Promise<void> =>
    files.write(file, `${JSON.stringify({ version: 1, secrets: entries })}\n`);

  return {
    get: (key) =>
      serialised(async () => {
        const stored = (await load())[key];
        if (stored === undefined || !cipher.available()) return undefined;
        try {
          return cipher.decrypt(Buffer.from(stored, 'base64'));
        } catch {
          // Encrypted for another user or computer (a copied profile): as good as absent.
          return undefined;
        }
      }),
    set: (key, value) =>
      serialised(async () => {
        if (!cipher.available()) throw new SecretsUnavailableError();
        const entries = await load();
        entries[key] = cipher.encrypt(value).toString('base64');
        await save(entries);
      }),
    delete: (key) =>
      serialised(async () => {
        const entries = await load();
        if (!(key in entries)) return;
        delete entries[key];
        await save(entries);
      }),
  };
}
