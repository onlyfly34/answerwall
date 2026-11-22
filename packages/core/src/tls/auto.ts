import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_KEYS } from '../contracts/index.ts';
import type {
  Clock,
  Logger,
  RandomSource,
  SecretStore,
  TlsMaterial,
  TlsProvider,
} from '../contracts/index.ts';
import {
  certificateNames,
  generateCa,
  generateServerCertificate,
  isNotYetValid,
  isUsableCa,
  isUsableServerCertificate,
} from './certificates.ts';
import type { CertificateAndKey } from './certificates.ts';

/** How often a running server checks whether its certificate is due for renewal. */
export const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60_000;

export const CA_CERTIFICATE_FILE = 'ca.crt';
export const SERVER_CERTIFICATE_FILE = 'server.crt';

export interface AutoTlsOptions {
  /** DNS names and IP addresses to issue for; the loopback names are always added. */
  hostnames: readonly string[];
  /** Where the two certificates are kept. The private keys go to `secrets`. */
  directory: string;
  secrets: SecretStore;
  logger: Logger;
  clock: Clock;
  random: RandomSource;
}

interface Issued {
  ca: CertificateAndKey;
  server: CertificateAndKey;
}

const toMaterial = ({ ca, server }: Issued): TlsMaterial => ({
  // Leaf first, then the CA, so clients that only trust the CA see the whole chain.
  cert: `${server.cert.trimEnd()}\n${ca.cert.trimEnd()}\n`,
  key: server.key,
});

/**
 * `auto` mode: a private certificate authority and a server certificate
 * signed by it, generated on first use and kept across restarts. The server
 * certificate is issued again when the configured names change, when the CA
 * was replaced, or 30 days before it expires (also while running).
 * @throws Error when a configured name is neither a DNS name nor an IP address.
 */
export function createAutoTlsProvider(options: AutoTlsOptions): TlsProvider {
  const { directory, secrets, logger, clock, random } = options;
  const names = certificateNames(options.hostnames);
  const caFile = join(directory, CA_CERTIFICATE_FILE);
  const serverFile = join(directory, SERVER_CERTIFICATE_FILE);
  const listeners = new Set<(material: TlsMaterial) => void>();

  let issued: Promise<Issued> | undefined;
  let cancelCheck: (() => void) | undefined;
  let closed = false;

  const load = async (file: string, secretKey: string): Promise<CertificateAndKey | null> => {
    const cert = await readFile(file, 'utf8').catch(() => undefined);
    const key = await secrets.get(secretKey);
    return cert !== undefined && key !== undefined ? { cert, key } : null;
  };

  const store = async (file: string, secretKey: string, pair: CertificateAndKey) => {
    await secrets.set(secretKey, pair.key);
    await mkdir(directory, { recursive: true });
    // Written beside the target and renamed, so a crash never leaves half a certificate.
    const temporary = `${file}.new`;
    await writeFile(temporary, pair.cert, { mode: 0o644 });
    await rename(temporary, file);
  };

  const ensure = async (): Promise<Issued> => {
    const now = clock.now();

    let ca = await load(caFile, SECRET_KEYS.tlsCaKey);
    if (!ca || !isUsableCa(ca, now)) {
      const replacing = ca !== null;
      ca = await generateCa(now, random);
      await store(caFile, SECRET_KEYS.tlsCaKey, ca);
      if (replacing) {
        logger.warn('the private CA was replaced: devices must install the new CA certificate');
      } else {
        logger.info('generated a private CA; install its certificate on your devices');
      }
    } else if (isNotYetValid(ca.cert, now)) {
      logger.warn(
        'the private CA is dated in the future: the system clock looks wrong; keeping the CA',
      );
    }

    let server = await load(serverFile, SECRET_KEYS.tlsServerKey);
    if (!server || !isUsableServerCertificate(server, ca, names, now)) {
      server = await generateServerCertificate(ca, names, now, random);
      await store(serverFile, SECRET_KEYS.tlsServerKey, server);
      logger.info('issued a server certificate', { names });
    }
    return { ca, server };
  };

  const scheduleCheck = (): void => {
    if (closed) return;
    cancelCheck = clock.schedule(RENEWAL_CHECK_INTERVAL_MS, () => void check());
  };

  const check = async (): Promise<void> => {
    try {
      const before = await issued;
      const after = await ensure();
      if (closed) return;
      issued = Promise.resolve(after);
      if (after.server.cert !== before?.server.cert) {
        const material = toMaterial(after);
        for (const listener of listeners) listener(material);
      }
    } catch (error) {
      logger.error('certificate renewal failed; keeping the current certificate', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    scheduleCheck();
  };

  const current = (): Promise<Issued> => {
    if (!issued) {
      const first = ensure();
      issued = first;
      first.then(scheduleCheck, () => {
        // Let the next call try again instead of caching the failure.
        if (issued === first) issued = undefined;
      });
    }
    return issued;
  };

  return {
    mode: 'auto',
    material: async () => toMaterial(await current()),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    caCertificatePem: async () => (await current()).ca.cert,
    async close() {
      closed = true;
      cancelCheck?.();
      listeners.clear();
    },
  };
}
