import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createEncryptedSecretStore, SecretsUnavailableError } from './secrets.ts';
import type { Cipher, SecretFiles } from './secrets.ts';

/** Reversible and obviously not the plain text; stands in for the system's encryption. */
function fakeCipher(owner = 'me'): Cipher & { enabled: boolean } {
  const cipher = {
    enabled: true,
    available: () => cipher.enabled,
    encrypt: (plain: string) =>
      Buffer.from(`${owner}:${Buffer.from(plain, 'utf8').toString('hex')}`, 'utf8'),
    decrypt(data: Buffer) {
      const [sealedBy, hex = ''] = data.toString('utf8').split(':');
      if (sealedBy !== owner) throw new Error('not mine');
      return Buffer.from(hex, 'hex').toString('utf8');
    },
  };
  return cipher;
}

function memoryFiles(initial?: string): SecretFiles & { content: string | undefined } {
  const files = {
    content: initial,
    read: async () => files.content,
    async write(_file: string, content: string) {
      files.content = content;
    },
  };
  return files;
}

const API_KEY = 'sk-test-0123456789';

describe('createEncryptedSecretStore', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('a value comes back as it was stored', async () => {
    const store = createEncryptedSecretStore({
      file: 'secrets.json',
      cipher: fakeCipher(),
      files: memoryFiles(),
    });

    await store.set('provider.home.api-key', API_KEY);

    expect(await store.get('provider.home.api-key')).toBe(API_KEY);
    expect(await store.get('provider.other.api-key')).toBeUndefined();
  });

  test('the file holds the key names and never a value in plain text', async () => {
    const files = memoryFiles();
    const store = createEncryptedSecretStore({ file: 'secrets.json', cipher: fakeCipher(), files });

    await store.set('provider.home.api-key', API_KEY);

    expect(files.content).toContain('provider.home.api-key');
    expect(files.content).not.toContain(API_KEY);
    expect(Buffer.from(files.content ?? '', 'utf8').toString('base64')).not.toContain(API_KEY);
    const document = JSON.parse(files.content ?? '') as { secrets: Record<string, string> };
    expect(Buffer.from(document.secrets['provider.home.api-key'] ?? '', 'base64').toString()).toBe(
      `me:${Buffer.from(API_KEY).toString('hex')}`,
    );
  });

  test('delete removes one value and leaves the others', async () => {
    const store = createEncryptedSecretStore({
      file: 'secrets.json',
      cipher: fakeCipher(),
      files: memoryFiles(),
    });
    await store.set('a', 'one');
    await store.set('b', 'two');

    await store.delete('a');
    await store.delete('never-there');

    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBe('two');
  });

  test('without encryption nothing is stored, and the error says nothing of the value', async () => {
    const cipher = fakeCipher();
    cipher.enabled = false;
    const files = memoryFiles();
    const store = createEncryptedSecretStore({ file: 'secrets.json', cipher, files });

    const failure = await store.set('a', API_KEY).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SecretsUnavailableError);
    expect(String(failure)).not.toContain(API_KEY);
    expect(files.content).toBeUndefined();
    expect(await store.get('a')).toBeUndefined();
  });

  test('a value encrypted for someone else reads as absent', async () => {
    const files = memoryFiles();
    await createEncryptedSecretStore({
      file: 'secrets.json',
      cipher: fakeCipher('someone-else'),
      files,
    }).set('a', API_KEY);

    const mine = createEncryptedSecretStore({ file: 'secrets.json', cipher: fakeCipher(), files });

    expect(await mine.get('a')).toBeUndefined();
  });

  test('changes made at the same time do not lose one another', async () => {
    const store = createEncryptedSecretStore({
      file: 'secrets.json',
      cipher: fakeCipher(),
      files: memoryFiles(),
    });

    await Promise.all([store.set('a', '1'), store.set('b', '2'), store.set('c', '3')]);

    expect(await Promise.all(['a', 'b', 'c'].map((key) => store.get(key)))).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  test('a damaged file is reported without its content, and the store works again once it is gone', async () => {
    const files = memoryFiles(`{"secrets": "${API_KEY}`);
    const store = createEncryptedSecretStore({ file: 'secrets.json', cipher: fakeCipher(), files });

    const failure = await store.get('a').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(API_KEY);

    files.content = undefined;
    await store.set('a', 'fresh');
    expect(await store.get('a')).toBe('fresh');
  });

  test('on disk: survives a restart, in a directory that did not exist', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'desktop-secrets-'));
    const file = path.join(dir, 'nested', 'secrets.json');

    await createEncryptedSecretStore({ file, cipher: fakeCipher() }).set('a', API_KEY);

    expect(await createEncryptedSecretStore({ file, cipher: fakeCipher() }).get('a')).toBe(API_KEY);
    expect(readFileSync(file, 'utf8')).not.toContain(API_KEY);
  });
});
