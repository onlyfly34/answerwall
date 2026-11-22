import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { TlsMaterial, TlsProvider } from '../contracts/index.ts';
import { systemRandom } from '../system.ts';
import { createMemoryLogger, FakeClock } from '../testing/index.ts';
import { createCertFilesProvider, RECHECK_INTERVAL_MS, RELOAD_DEBOUNCE_MS } from './cert-files.ts';
import { certificateNames, generateCa, generateServerCertificate } from './certificates.ts';
import type { CertificateAndKey } from './certificates.ts';

let first: CertificateAndKey;
let second: CertificateAndKey;

beforeAll(async () => {
  const now = Date.now();
  const ca = await generateCa(now, systemRandom);
  const names = certificateNames([]);
  first = await generateServerCertificate(ca, names, now, systemRandom);
  second = await generateServerCertificate(ca, names, now, systemRandom);
});

let directory: string;
let certFile: string;
let keyFile: string;
let clock: FakeClock;
let logger: ReturnType<typeof createMemoryLogger>;
let provider: TlsProvider;
let changes: TlsMaterial[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tls-cert-'));
  certFile = join(directory, 'server.crt');
  keyFile = join(directory, 'server.key');
  await writeFile(certFile, first.cert);
  await writeFile(keyFile, first.key);
  clock = new FakeClock();
  logger = createMemoryLogger();
  provider = createCertFilesProvider({ certFile, keyFile, logger, clock });
  changes = [];
  provider.onChange((material) => changes.push(material));
});

afterEach(async () => {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
});

const warnings = () => logger.entries.filter((entry) => entry.level === 'warn');

describe('cert mode', () => {
  test('serves the files it is pointed to', async () => {
    expect(provider.mode).toBe('cert');
    expect(await provider.material()).toEqual({ cert: first.cert, key: first.key });
    expect(changes).toEqual([]);
  });

  test('a mismatched pair at start is an error that names the problem, not the content', async () => {
    await writeFile(keyFile, second.key);
    await expect(provider.material()).rejects.toThrow(
      'The TLS certificate cannot be loaded: the private key does not belong to the certificate',
    );
  });

  test('a renewed pair is picked up by the periodic check and announced once', async () => {
    await provider.material();
    await writeFile(certFile, second.cert);
    await writeFile(keyFile, second.key);

    await clock.advance(RECHECK_INTERVAL_MS);
    await expect.poll(() => changes.length).toBe(1);

    expect(changes[0]).toEqual({ cert: second.cert, key: second.key });
    expect(await provider.material()).toEqual(changes[0]);

    await clock.advance(RECHECK_INTERVAL_MS);
    await clock.advance(RELOAD_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
  });

  test('a file change triggers a reload after the debounce period', async () => {
    await provider.material();
    const idle = clock.pendingTimers;

    // Replaced the way renewal tools do it: written beside, then renamed.
    await writeFile(`${keyFile}.tmp`, second.key);
    await writeFile(`${certFile}.tmp`, second.cert);
    await rename(`${keyFile}.tmp`, keyFile);
    await rename(`${certFile}.tmp`, certFile);

    // The change notification arrives from the operating system.
    await expect.poll(() => clock.pendingTimers, { timeout: 5000 }).toBeGreaterThan(idle);
    expect(changes).toEqual([]);
    await clock.advance(RELOAD_DEBOUNCE_MS);
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toEqual({ cert: second.cert, key: second.key });
  });

  test('an invalid replacement is refused with a warning and the old certificate stays', async () => {
    await provider.material();
    await writeFile(certFile, 'this is not a certificate');

    await clock.advance(RECHECK_INTERVAL_MS);
    await expect.poll(() => warnings().length).toBeGreaterThan(0);

    expect(changes).toEqual([]);
    expect(await provider.material()).toEqual({ cert: first.cert, key: first.key });
    expect(JSON.stringify(warnings())).not.toContain(directory);
  });

  test('a half-finished renewal (new certificate, old key) keeps the old pair until the key follows', async () => {
    await provider.material();
    await writeFile(certFile, second.cert);
    await clock.advance(RECHECK_INTERVAL_MS);
    await expect.poll(() => warnings().length).toBeGreaterThan(0);
    expect(changes).toEqual([]);

    await writeFile(keyFile, second.key);
    await clock.advance(RECHECK_INTERVAL_MS);
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toEqual({ cert: second.cert, key: second.key });
  });

  test('a deleted file keeps the certificate in use and the warning carries no path', async () => {
    await provider.material();
    await rm(keyFile);

    await clock.advance(RECHECK_INTERVAL_MS);
    await expect.poll(() => warnings().length).toBeGreaterThan(0);

    expect(await provider.material()).toEqual({ cert: first.cert, key: first.key });
    expect(warnings().at(-1)?.fields).toEqual({ reason: 'ENOENT' });
  });

  test('close stops watching and checking', async () => {
    await provider.material();
    await provider.close();
    expect(clock.pendingTimers).toBe(0);

    await writeFile(certFile, second.cert);
    await writeFile(keyFile, second.key);
    await clock.advance(RECHECK_INTERVAL_MS);
    expect(changes).toEqual([]);
  });
});
