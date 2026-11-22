import { X509Certificate } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createCountingRandom } from '../testing/index.ts';
import {
  certificateNames,
  generateCa,
  generateServerCertificate,
  isNotYetValid,
  isUsableCa,
  isUsableServerCertificate,
  namesOf,
  RENEW_BEFORE_MS,
  validateMaterial,
} from './certificates.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 5, 1);

describe('certificateNames', () => {
  test('adds the loopback names, canonicalises and sorts', () => {
    expect(
      certificateNames(['NAS.Local', '[2001:DB8:0:0::1]', '192.168.1.5', 'nas.local']),
    ).toEqual(['127.0.0.1', '192.168.1.5', '2001:db8::1', '::1', 'localhost', 'nas.local']);
  });

  test('accepts a wildcard name', () => {
    expect(certificateNames(['*.home.example'])).toContain('*.home.example');
  });

  test.each(['', 'has space', 'https://nas.local', 'nas.local:8443', '-bad.example', 'a..b'])(
    'refuses %j',
    (name) => {
      expect(() => certificateNames([name])).toThrow(/Not a DNS name or IP address/);
    },
  );
});

describe('generated certificates', () => {
  test('the CA is a self-signed certificate authority limited to signing server certificates', async () => {
    const ca = await generateCa(NOW, createCountingRandom());
    const cert = new X509Certificate(ca.cert);

    expect(cert.ca).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.subject).toContain('Local CA');
    expect(cert.validToDate.getTime()).toBeGreaterThan(NOW + 3000 * DAY);
    expect(ca.key).toContain('BEGIN PRIVATE KEY');
    expect(isUsableCa(ca, NOW)).toBe(true);
  });

  test('the server certificate carries DNS and IP subject alternative names and is signed by the CA', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const names = certificateNames(['nas.local', '192.168.1.5', '2001:db8::1']);
    const server = await generateServerCertificate(ca, names, NOW, random);
    const cert = new X509Certificate(server.cert);

    expect(cert.ca).toBe(false);
    expect(cert.subjectAltName).toContain('DNS:nas.local');
    expect(cert.subjectAltName).toContain('DNS:localhost');
    expect(cert.subjectAltName).toContain('IP Address:192.168.1.5');
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(namesOf(server.cert)).toEqual(names);
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
    expect(cert.checkIssued(new X509Certificate(ca.cert))).toBe(true);
    expect(cert.validToDate.getTime() - NOW).toBeLessThanOrEqual(397 * DAY);
    expect(isUsableServerCertificate(server, ca, names, NOW)).toBe(true);
  });

  test('two certificates never share a serial number', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const names = certificateNames([]);
    const first = await generateServerCertificate(ca, names, NOW, random);
    const second = await generateServerCertificate(ca, names, NOW, random);
    expect(new X509Certificate(first.cert).serialNumber).not.toBe(
      new X509Certificate(second.cert).serialNumber,
    );
  });

  test('a server certificate is unusable for other names, another CA, a foreign key or near expiry', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const otherCa = await generateCa(NOW, random);
    const names = certificateNames(['nas.local']);
    const server = await generateServerCertificate(ca, names, NOW, random);
    const other = await generateServerCertificate(ca, names, NOW, random);

    expect(isUsableServerCertificate(server, ca, certificateNames(['other.local']), NOW)).toBe(
      false,
    );
    expect(isUsableServerCertificate(server, otherCa, names, NOW)).toBe(false);
    expect(isUsableServerCertificate({ cert: server.cert, key: other.key }, ca, names, NOW)).toBe(
      false,
    );
    expect(isUsableServerCertificate({ cert: 'garbage', key: server.key }, ca, names, NOW)).toBe(
      false,
    );
    const nearExpiry = NOW + 397 * DAY - RENEW_BEFORE_MS + DAY;
    expect(isUsableServerCertificate(server, ca, names, nearExpiry - 2 * DAY)).toBe(true);
    expect(isUsableServerCertificate(server, ca, names, nearExpiry)).toBe(false);
  });

  test('a server certificate is not accepted as a CA', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const server = await generateServerCertificate(ca, certificateNames([]), NOW, random);
    expect(isUsableCa(server, NOW)).toBe(false);
  });

  test('a CA that is not valid yet stays usable; an expiring one does not', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const server = await generateServerCertificate(ca, certificateNames([]), NOW, random);
    const clockBehind = NOW - 2 * 60 * 60_000;

    // A clock that runs behind must not cost the devices their installed CA.
    expect(isUsableCa(ca, clockBehind)).toBe(true);
    expect(isNotYetValid(ca.cert, clockBehind)).toBe(true);
    expect(isNotYetValid(ca.cert, NOW)).toBe(false);
    expect(isUsableCa(ca, NOW + 3650 * DAY - RENEW_BEFORE_MS + DAY)).toBe(false);
    // The server certificate is cheap to issue again.
    expect(isUsableServerCertificate(server, ca, certificateNames([]), clockBehind)).toBe(false);
  });

  test('a server certificate never outlives its CA', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const lateInCaLife = NOW + 3600 * DAY;
    const server = await generateServerCertificate(ca, certificateNames([]), lateInCaLife, random);
    expect(new X509Certificate(server.cert).validToDate.getTime()).toBe(
      new X509Certificate(ca.cert).validToDate.getTime(),
    );
  });
});

describe('validateMaterial', () => {
  test('accepts a matching pair and names what is wrong otherwise, without file content', async () => {
    const random = createCountingRandom();
    const ca = await generateCa(NOW, random);
    const other = await generateCa(NOW, random);

    expect(validateMaterial(ca.cert, ca.key)).toEqual({ cert: ca.cert, key: ca.key });
    expect(() => validateMaterial('not a certificate', ca.key)).toThrow(/not a PEM certificate/);
    expect(() => validateMaterial(ca.cert, 'not a key')).toThrow(/private key/);
    expect(() => validateMaterial(ca.cert, other.key)).toThrow(/does not belong/);
  });
});
