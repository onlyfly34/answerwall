import { createHash, timingSafeEqual } from 'node:crypto';
import type { RandomSource } from '../contracts/index.ts';
import { PAIRING_CODE_DIGITS } from '../protocol/index.ts';

const DEVICE_TOKEN_BYTES = 32;

/** Lowercase hex SHA-256: the only form in which a token or a pairing code is stored. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Compares two secrets without revealing, through timing, where they differ.
 * Both sides are hashed first, so their lengths do not matter either.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** A new 256-bit device token, base64url (43 characters). */
export function generateDeviceToken(random: RandomSource): string {
  return Buffer.from(random.bytes(DEVICE_TOKEN_BYTES)).toString('base64url');
}

/** A uniformly distributed pairing code of `PAIRING_CODE_DIGITS` decimal digits. */
export function generatePairingCode(random: RandomSource): string {
  const range = 10 ** PAIRING_CODE_DIGITS;
  // Values at or above the largest multiple of `range` would bias the result.
  const unbiased = Math.floor(2 ** 32 / range) * range;
  for (;;) {
    const value = Buffer.from(random.bytes(4)).readUInt32BE(0);
    if (value < unbiased) return String(value % range).padStart(PAIRING_CODE_DIGITS, '0');
  }
}

/** `1234 5678`: how a pairing code is shown to a person. */
export function formatPairingCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}
