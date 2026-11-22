// The X.509 library's dependency injection needs this polyfill loaded before it.
import 'reflect-metadata';
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import * as x509 from '@peculiar/x509';
import { BRAND } from '../brand.ts';
import type { RandomSource, TlsMaterial } from '../contracts/index.ts';

const DAY_MS = 24 * 60 * 60_000;
/** Certificates are dated slightly in the past, for clients whose clock runs behind. */
const CLOCK_SKEW_MS = 60 * 60_000;
const CA_LIFETIME_MS = 3650 * DAY_MS;
/** Within what Apple platforms accept for a server certificate from a user-installed CA. */
const SERVER_LIFETIME_MS = 397 * DAY_MS;
/** A certificate this close to its end is replaced. */
export const RENEW_BEFORE_MS = 30 * DAY_MS;

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Names every generated server certificate covers, whatever is configured. */
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'];

export interface CertificateAndKey {
  /** PEM. */
  cert: string;
  /** PEM, PKCS #8. */
  key: string;
}

/** The compressed lowercase form of an IPv6 literal, as the URL parser writes it. */
const canonicalIpv6 = (literal: string): string =>
  new URL(`http://[${literal}]`).hostname.slice(1, -1);

function canonicalName(name: string): string {
  const trimmed = name
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return isIP(trimmed) === 6 ? canonicalIpv6(trimmed) : trimmed;
}

const DNS_NAME =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The names a server certificate is issued for: the configured ones plus the
 * loopback names, canonical, without duplicates, sorted.
 * @throws Error naming an entry that is neither a DNS name nor an IP address.
 */
export function certificateNames(hostnames: readonly string[]): string[] {
  const names = new Set<string>();
  for (const hostname of [...hostnames, ...LOOPBACK_NAMES]) {
    const name = canonicalName(hostname);
    if (isIP(name) === 0 && !(name.length <= 253 && DNS_NAME.test(name))) {
      throw new Error(`Not a DNS name or IP address: "${hostname}"`);
    }
    names.add(name);
  }
  return [...names].sort();
}

/** The subject alternative names of a certificate, in the form {@link certificateNames} returns. */
export function namesOf(certPem: string): string[] {
  const san = new X509Certificate(certPem).subjectAltName ?? '';
  const names = san
    .split(', ')
    .map((entry) => /^(?:DNS|IP Address):(.+)$/.exec(entry)?.[1])
    .filter((name): name is string => name !== undefined)
    .map(canonicalName);
  return [...new Set(names)].sort();
}

function serialNumber(random: RandomSource): string {
  const bytes = random.bytes(16);
  // A serial number is a positive integer: clear the sign bit, keep it non-zero.
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01;
  return Buffer.from(bytes).toString('hex');
}

async function exportPrivateKey(key: webcrypto.CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

function generateKeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
}

/** A new private certificate authority that can sign server certificates only. */
export async function generateCa(now: number, random: RandomSource): Promise<CertificateAndKey> {
  const keys = await generateKeyPair();
  // The serial in the name tells two generations of the CA apart in a trust store.
  const serial = serialNumber(random);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: serial,
      name: `CN=${BRAND.name} Local CA ${serial.slice(0, 8)}, O=${BRAND.name}`,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + CA_LIFETIME_MS),
      signingAlgorithm: SIGNING_ALGORITHM,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    },
    webcrypto,
  );
  return { cert: cert.toString('pem'), key: await exportPrivateKey(keys.privateKey) };
}

/** A server certificate for `names`, signed by `ca`. It never outlives the CA. */
export async function generateServerCertificate(
  ca: CertificateAndKey,
  names: readonly string[],
  now: number,
  random: RandomSource,
): Promise<CertificateAndKey> {
  const caCert = new x509.X509Certificate(ca.cert);
  const caKey = await webcrypto.subtle.importKey(
    'pkcs8',
    createPrivateKey(ca.key).export({ type: 'pkcs8', format: 'der' }),
    KEY_ALGORITHM,
    false,
    ['sign'],
  );
  const keys = await generateKeyPair();
  const cert = await x509.X509CertificateGenerator.create(
    {
      serialNumber: serialNumber(random),
      subject: `CN=${names.find((name) => isIP(name) === 0) ?? BRAND.name}, O=${BRAND.name}`,
      issuer: caCert.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(Math.min(now + SERVER_LIFETIME_MS, caCert.notAfter.getTime())),
      signingAlgorithm: SIGNING_ALGORITHM,
      publicKey: keys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(
          names.map((name) => ({ type: isIP(name) === 0 ? 'dns' : 'ip', value: name })),
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(caCert.publicKey),
      ],
    },
    webcrypto,
  );
  return { cert: cert.toString('pem'), key: await exportPrivateKey(keys.privateKey) };
}

/** Whether `pair` is a certificate with its own private key that stays valid past the renewal margin. */
function isUnexpired(pair: CertificateAndKey, now: number): boolean {
  try {
    const cert = new X509Certificate(pair.cert);
    return (
      cert.checkPrivateKey(createPrivateKey(pair.key)) &&
      cert.validToDate.getTime() - now > RENEW_BEFORE_MS
    );
  } catch {
    return false;
  }
}

/** Whether the certificate's validity starts after `now`: the local clock is behind, or the file is unreadable. */
export function isNotYetValid(certPem: string, now: number): boolean {
  try {
    return new X509Certificate(certPem).validFromDate.getTime() > now;
  } catch {
    return false;
  }
}

/**
 * Whether `ca` can keep signing: a self-signed CA with its own key, not
 * close to expiry. A CA that is not valid *yet* stays usable: that means the
 * local clock is behind, and replacing the CA would break every device that
 * installed it.
 */
export function isUsableCa(ca: CertificateAndKey, now: number): boolean {
  if (!isUnexpired(ca, now)) return false;
  const cert = new X509Certificate(ca.cert);
  return cert.ca && cert.verify(cert.publicKey);
}

/** Whether `server` can keep being served: signed by `ca`, for exactly `names`, not close to expiry. */
export function isUsableServerCertificate(
  server: CertificateAndKey,
  ca: CertificateAndKey,
  names: readonly string[],
  now: number,
): boolean {
  if (!isUnexpired(server, now) || isNotYetValid(server.cert, now)) return false;
  const cert = new X509Certificate(server.cert);
  const issuer = new X509Certificate(ca.cert);
  return (
    cert.checkIssued(issuer) &&
    cert.verify(issuer.publicKey) &&
    namesOf(server.cert).join() === [...names].join()
  );
}

/**
 * Checks that a certificate and a key from files belong together and can be
 * served. Returns the material, or throws an Error without any file content.
 */
export function validateMaterial(cert: string, key: string): TlsMaterial {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert);
  } catch {
    throw new Error('the certificate file is not a PEM certificate');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(key);
  } catch {
    throw new Error('the key file is not an unencrypted PEM private key');
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error('the private key does not belong to the certificate');
  }
  return { cert, key };
}
