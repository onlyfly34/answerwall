import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { get, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SECRET_KEYS } from '../contracts/index.ts';
import type { SecretStore, TlsMaterial, TlsProvider } from '../contracts/index.ts';
import { systemClock, systemRandom } from '../system.ts';
import {
  createCountingRandom,
  createFakeSecretStore,
  createMemoryLogger,
  createTestConfig,
  FakeClock,
} from '../testing/index.ts';
import { CA_CERTIFICATE_FILE, RENEWAL_CHECK_INTERVAL_MS, SERVER_CERTIFICATE_FILE } from './auto.ts';
import { namesOf } from './certificates.ts';
import { createTlsProvider, TLS_DIRECTORY } from './index.ts';

const DAY = 24 * 60 * 60_000;

let dataDir: string;
const providers: TlsProvider[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tls-auto-'));
});

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  await rm(dataDir, { recursive: true, force: true });
});

function autoProvider(
  hostnames: string[],
  secrets: SecretStore,
  clock = new FakeClock(),
  logger = createMemoryLogger(),
): TlsProvider {
  const provider = createTlsProvider({
    config: createTestConfig({ dataDir, tls: { mode: 'auto', hostnames } }),
    secrets,
    logger,
    clock,
    random: createCountingRandom(),
  });
  providers.push(provider);
  return provider;
}

const leafOf = (material: TlsMaterial | null): X509Certificate =>
  new X509Certificate(material?.cert ?? '');

function request(port: number, host: string, ca: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host, port, path: '/', ca, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

describe('auto mode', () => {
  test('a client that trusts only the generated CA completes a TLS handshake by name and by IP', async () => {
    const provider = createTlsProvider({
      config: createTestConfig({ dataDir, tls: { mode: 'auto', hostnames: [] } }),
      secrets: createFakeSecretStore(),
      logger: createMemoryLogger(),
      clock: systemClock,
      random: systemRandom,
    });
    providers.push(provider);
    const material = await provider.material();
    const ca = await provider.caCertificatePem();
    const server = createServer(material ?? {}, (_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      expect(await request(port, 'localhost', ca ?? undefined)).toBe(200);
      expect(await request(port, '127.0.0.1', ca ?? undefined)).toBe(200);
      // Without the CA the certificate is not trusted.
      await expect(request(port, 'localhost', undefined)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('issues for the configured names plus loopback, leaf first with the CA behind it', async () => {
    const provider = autoProvider(['nas.local', '192.168.1.5'], createFakeSecretStore());

    const material = await provider.material();
    const ca = await provider.caCertificatePem();

    expect(provider.mode).toBe('auto');
    expect(namesOf(material?.cert ?? '')).toEqual([
      '127.0.0.1',
      '192.168.1.5',
      '::1',
      'localhost',
      'nas.local',
    ]);
    expect(leafOf(material).ca).toBe(false);
    expect(material?.cert.trimEnd().endsWith((ca ?? '').trimEnd())).toBe(true);
    expect(new X509Certificate(ca ?? '').ca).toBe(true);
    expect(ca).not.toContain('PRIVATE KEY');
  });

  test('keeps private keys in the secret store and only certificates on disk', async () => {
    const secrets = createFakeSecretStore();
    const material = await autoProvider([], secrets).material();

    expect(await secrets.get(SECRET_KEYS.tlsServerKey)).toBe(material?.key);
    expect(await secrets.get(SECRET_KEYS.tlsCaKey)).toContain('BEGIN PRIVATE KEY');
    const directory = join(dataDir, TLS_DIRECTORY);
    for (const file of [CA_CERTIFICATE_FILE, SERVER_CERTIFICATE_FILE]) {
      const content = await readFile(join(directory, file), 'utf8');
      expect(content).toContain('BEGIN CERTIFICATE');
      expect(content).not.toContain('PRIVATE KEY');
    }
  });

  test('a restart reuses the CA and the server certificate', async () => {
    const secrets = createFakeSecretStore();
    const first = autoProvider(['nas.local'], secrets);
    const material = await first.material();
    const ca = await first.caCertificatePem();

    const second = autoProvider(['nas.local'], secrets);

    expect(await second.material()).toEqual(material);
    expect(await second.caCertificatePem()).toBe(ca);
  });

  test('changed names get a new server certificate from the same CA', async () => {
    const secrets = createFakeSecretStore();
    const first = autoProvider(['nas.local'], secrets);
    const before = await first.material();
    const ca = await first.caCertificatePem();

    const second = autoProvider(['nas.local', 'wall.local'], secrets);
    const after = await second.material();

    expect(await second.caCertificatePem()).toBe(ca);
    expect(after?.cert).not.toBe(before?.cert);
    expect(namesOf(after?.cert ?? '')).toContain('wall.local');
    expect(leafOf(after).checkIssued(new X509Certificate(ca ?? ''))).toBe(true);
  });

  test('a server certificate close to expiry is replaced at the next start', async () => {
    const secrets = createFakeSecretStore();
    const clock = new FakeClock();
    const before = await autoProvider([], secrets, clock).material();

    await clock.advance(380 * DAY);
    const after = await autoProvider([], secrets, clock).material();

    expect(after?.cert).not.toBe(before?.cert);
    expect(leafOf(after).validToDate.getTime()).toBeGreaterThan(clock.now() + 300 * DAY);
  });

  test('a running server renews its certificate and tells its listeners', async () => {
    const clock = new FakeClock();
    const provider = autoProvider([], createFakeSecretStore(), clock);
    const before = await provider.material();
    const changes: TlsMaterial[] = [];
    provider.onChange((material) => changes.push(material));

    // Each check does real file and crypto work; wait for it to schedule the next one.
    const checked = () => expect.poll(() => clock.pendingTimers).toBe(1);
    await clock.advance(300 * DAY);
    await checked();
    expect(changes).toEqual([]);

    await clock.advance(70 * DAY);
    await checked();
    await clock.advance(RENEWAL_CHECK_INTERVAL_MS);
    await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]?.cert).not.toBe(before?.cert);
    expect(await provider.material()).toEqual(changes[0]);
  });

  test('a lost CA key or a corrupt CA file leads to a new CA, with a warning', async () => {
    const secrets = createFakeSecretStore();
    const first = await autoProvider([], secrets).caCertificatePem();

    await secrets.delete(SECRET_KEYS.tlsCaKey);
    const second = await autoProvider([], secrets).caCertificatePem();
    expect(second).not.toBe(first);

    await writeFile(join(dataDir, TLS_DIRECTORY, CA_CERTIFICATE_FILE), 'garbage');
    const logger = createMemoryLogger();
    const third = autoProvider([], secrets, new FakeClock(), logger);
    expect(await third.caCertificatePem()).not.toBe(second);
    expect(
      logger.entries.some((e) => e.level === 'warn' && /CA was replaced/.test(e.message)),
    ).toBe(true);
    // The server certificate follows the new CA.
    expect(
      leafOf(await third.material()).checkIssued(
        new X509Certificate((await third.caCertificatePem()) ?? ''),
      ),
    ).toBe(true);
  });

  test('a start with the clock behind keeps the CA and warns about the clock', async () => {
    const secrets = createFakeSecretStore();
    const clock = new FakeClock(Date.UTC(2026, 0, 10));
    const ca = await autoProvider([], secrets, clock).caCertificatePem();

    // Before time synchronisation: a day before the CA was created.
    const logger = createMemoryLogger();
    const early = autoProvider([], secrets, new FakeClock(Date.UTC(2026, 0, 9)), logger);

    expect(await early.caCertificatePem()).toBe(ca);
    expect(leafOf(await early.material()).checkIssued(new X509Certificate(ca ?? ''))).toBe(true);
    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings.map((entry) => entry.message)).toEqual([
      'the private CA is dated in the future: the system clock looks wrong; keeping the CA',
    ]);

    // With the clock corrected the same CA is still in place.
    expect(await autoProvider([], secrets, clock).caCertificatePem()).toBe(ca);
  });

  test('an invalid configured name is refused when the provider is created', () => {
    expect(() => autoProvider(['not a name'], createFakeSecretStore())).toThrow(/not a name/);
  });

  test('close stops the renewal check', async () => {
    const clock = new FakeClock();
    const provider = autoProvider([], createFakeSecretStore(), clock);
    await provider.material();
    await clock.advance(0);
    expect(clock.pendingTimers).toBe(1);

    await provider.close();
    expect(clock.pendingTimers).toBe(0);
    await clock.advance(RENEWAL_CHECK_INTERVAL_MS);
    expect(clock.pendingTimers).toBe(0);
  });

  test('a failing secret store is reported and retried on the next call', async () => {
    const secrets = createFakeSecretStore();
    let fail = true;
    const flaky: SecretStore = {
      ...secrets,
      set: async (key, value) => {
        if (fail) throw new Error('store unavailable');
        await secrets.set(key, value);
      },
    };
    const provider = autoProvider([], flaky);

    await expect(provider.material()).rejects.toThrow('store unavailable');
    fail = false;
    expect((await provider.material())?.cert).toContain('BEGIN CERTIFICATE');
  });
});

describe('mode selection', () => {
  test('off mode has no material and no CA', async () => {
    const provider = createTlsProvider({
      config: createTestConfig(),
      secrets: createFakeSecretStore(),
      logger: createMemoryLogger(),
    });
    expect(provider.mode).toBe('off');
    expect(await provider.material()).toBeNull();
    expect(await provider.caCertificatePem()).toBeNull();
    provider.onChange(() => {})();
    await provider.close();
  });

  test('cert mode is chosen for certificate files and has no CA to offer', async () => {
    const provider = createTlsProvider({
      config: createTestConfig({
        tls: { mode: 'cert', certFile: join(dataDir, 'a.crt'), keyFile: join(dataDir, 'a.key') },
      }),
      secrets: createFakeSecretStore(),
      logger: createMemoryLogger(),
      clock: new FakeClock(),
    });
    providers.push(provider);
    expect(provider.mode).toBe('cert');
    expect(await provider.caCertificatePem()).toBeNull();
    await expect(provider.material()).rejects.toThrow(/cannot be loaded.*ENOENT/);
  });
});
