import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SECRET_KEYS, secretEnvName } from '../contracts/index.ts';
import { createFileSecretStore } from './secret-store.ts';

const posixOnly = test.skipIf(process.platform === 'win32');
const KEY = SECRET_KEYS.providerApiKey('local-llm');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secret-store-'));
  file = join(dir, 'secrets.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const store = (env: NodeJS.ProcessEnv = {}) => createFileSecretStore({ file, env });
const mode = (path: string): number => statSync(path).mode & 0o777;

describe('stored secrets', () => {
  test('a missing file holds nothing, and reading does not create it', async () => {
    expect(await store().get(KEY)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('set, get, replace and delete', async () => {
    const secrets = store();

    await secrets.set(KEY, 'sk-first');
    expect(await secrets.get(KEY)).toBe('sk-first');

    await secrets.set(KEY, 'sk-second');
    expect(await secrets.get(KEY)).toBe('sk-second');

    await secrets.delete(KEY);
    expect(await secrets.get(KEY)).toBeUndefined();
  });

  test('values persist for the next store on the same file', async () => {
    await store().set(KEY, 'sk-kept');
    await store().set(SECRET_KEYS.tlsServerKey, '-----BEGIN PRIVATE KEY-----\nabc\n');

    expect(await store().get(KEY)).toBe('sk-kept');
    expect(await store().get(SECRET_KEYS.tlsServerKey)).toBe('-----BEGIN PRIVATE KEY-----\nabc\n');
  });

  test('keys are independent, including ones that look like object internals', async () => {
    const secrets = store();
    await secrets.set('__proto__', 'one');
    await secrets.set('constructor', 'two');
    await secrets.set(KEY, 'three');

    await secrets.delete('constructor');

    expect(await secrets.get('__proto__')).toBe('one');
    expect(await secrets.get('constructor')).toBeUndefined();
    expect(await secrets.get('toString')).toBeUndefined();
    expect(await secrets.get(KEY)).toBe('three');
  });

  test('deleting a key that is not stored does nothing and creates no file', async () => {
    await store().delete(KEY);

    expect(readdirSync(dir)).toEqual([]);
  });

  test('an empty value is refused', async () => {
    await expect(store().set(KEY, '')).rejects.toMatchObject({ code: 'bad_request' });
    expect(readdirSync(dir)).toEqual([]);
  });

  test('the data directory is created when it does not exist yet', async () => {
    const nested = createFileSecretStore({
      file: join(dir, 'new', 'data', 'secrets.json'),
      env: {},
    });

    await nested.set(KEY, 'sk-nested');

    expect(await nested.get(KEY)).toBe('sk-nested');
  });

  test('concurrent writes all land', async () => {
    const secrets = store();

    await Promise.all(
      Array.from({ length: 20 }, (_, n) => secrets.set(`key-${n}`, `value-${n}`)).concat(
        secrets.delete('key-0'),
      ),
    );

    expect(await secrets.get('key-0')).toBeUndefined();
    for (let n = 1; n < 20; n++) expect(await secrets.get(`key-${n}`)).toBe(`value-${n}`);
  });
});

describe('the file', () => {
  posixOnly('is readable and writable by its owner only', async () => {
    await store().set(KEY, 'sk-private');

    expect(mode(file)).toBe(0o600);
  });

  posixOnly('stays owner-only when rewritten, whatever the umask', async () => {
    const previous = process.umask(0);
    try {
      const secrets = store();
      await secrets.set(KEY, 'one');
      await secrets.set(KEY, 'two');
      await secrets.delete(KEY);
    } finally {
      process.umask(previous);
    }

    expect(mode(file)).toBe(0o600);
  });

  posixOnly('is tightened again when something widened its permissions', async () => {
    await store().set(KEY, 'sk-private');
    chmodSync(file, 0o644);

    expect(await store().get(KEY)).toBe('sk-private');

    expect(mode(file)).toBe(0o600);
  });

  test('is replaced atomically: no temporary file remains', async () => {
    const secrets = store();
    await secrets.set(KEY, 'one');
    await secrets.set('other', 'two');
    await secrets.delete(KEY);

    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });

  test('a temporary file left by a crashed write does not block the next one', async () => {
    writeFileSync(`${file}.${process.pid}.1.tmp`, 'half-written');

    await store().set(KEY, 'sk-after-crash');

    expect(await store().get(KEY)).toBe('sk-after-crash');
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });

  test('is versioned JSON separate from any database', async () => {
    await store().set(KEY, 'sk-json');

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      secrets: { [KEY]: 'sk-json' },
    });
  });

  test('setting the value that is already stored does not rewrite the file', async () => {
    await store().set(KEY, 'same');
    const before = statSync(file).ino;

    await store().set(KEY, 'same');

    expect(statSync(file).ino).toBe(before);
  });

  test.each([
    ['not JSON', '{"secrets": {"a": "b"'],
    ['not an object', '"text"'],
    ['null', 'null'],
    ['without secrets', '{"version": 1}'],
    ['secrets as a list', '{"secrets": ["a"]}'],
    ['a value that is not text', '{"secrets": {"a": 1}}'],
  ])(
    'a damaged file (%s) is reported, not overwritten, and its content is not quoted',
    async (_, content) => {
      writeFileSync(file, content);
      const secrets = store();

      const attempts = [
        () => secrets.get('a'),
        () => secrets.set('a', 'new'),
        () => secrets.delete('a'),
      ];
      for (const attempt of attempts) {
        const error: unknown = await attempt().then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/damaged/);
        expect((error as Error).message).not.toContain(content);
      }
      expect(readFileSync(file, 'utf8')).toBe(content);
    },
  );

  test('a failed write is reported and does not break later writes', async () => {
    const secrets = store();
    await secrets.set(KEY, 'kept');
    writeFileSync(file, 'damaged');

    await expect(secrets.set('other', 'value')).rejects.toThrow(/damaged/);
    rmSync(file);
    await secrets.set('other', 'value');

    expect(await secrets.get('other')).toBe('value');
  });
});

describe('environment overlay', () => {
  const envName = secretEnvName(KEY);

  test('a variable supplies the secret without any file', async () => {
    expect(await store({ [envName]: 'sk-from-env' }).get(KEY)).toBe('sk-from-env');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('the variable wins over the stored value', async () => {
    await store().set(KEY, 'sk-stored');

    expect(await store({ [envName]: 'sk-from-env' }).get(KEY)).toBe('sk-from-env');
  });

  test('an empty variable counts as not set', async () => {
    const secrets = store({ [envName]: '' });
    await secrets.set(KEY, 'sk-stored');

    expect(await secrets.get(KEY)).toBe('sk-stored');
  });

  test('setting a key the environment supplies is a conflict and stores nothing', async () => {
    const secrets = store({ [envName]: 'sk-from-env' });

    const error: unknown = await secrets.set(KEY, 'sk-new').catch((reason: unknown) => reason);

    expect(error).toMatchObject({ name: 'AppError', code: 'conflict' });
    expect((error as Error).message).toContain(envName);
    expect((error as Error).message).not.toContain('sk-');
    expect(await store().get(KEY)).toBeUndefined();
  });

  test('delete removes the stored value; the one from the environment remains', async () => {
    await store().set(KEY, 'sk-stored');
    const secrets = store({ [envName]: 'sk-from-env' });

    await secrets.delete(KEY);

    expect(await secrets.get(KEY)).toBe('sk-from-env');
    expect(await store().get(KEY)).toBeUndefined();
  });

  test('only the named key is overlaid', async () => {
    const secrets = store({ [envName]: 'sk-from-env' });
    await secrets.set(SECRET_KEYS.tlsCaKey, 'stored-ca-key');

    expect(await secrets.get(SECRET_KEYS.tlsCaKey)).toBe('stored-ca-key');
    expect(await secrets.get(SECRET_KEYS.providerApiKey('other'))).toBeUndefined();
  });

  test('the environment is read at call time', async () => {
    const env: NodeJS.ProcessEnv = {};
    const secrets = store(env);
    expect(await secrets.get(KEY)).toBeUndefined();

    env[envName] = 'sk-late';

    expect(await secrets.get(KEY)).toBe('sk-late');
  });
});
