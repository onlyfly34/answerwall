import { describe, expect, test } from 'vitest';
import type { RandomSource } from '../contracts/index.ts';
import { PairingCodeValueSchema } from '../protocol/index.ts';
import { systemRandom } from '../system.ts';
import { createCountingRandom } from '../testing/index.ts';
import {
  constantTimeEqual,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  sha256Hex,
} from './tokens.ts';

/** A random source that hands out the given 32-bit values, one per call. */
function scripted(values: number[]): RandomSource & { calls: number } {
  const source = {
    calls: 0,
    bytes: (length: number) => {
      const buffer = Buffer.alloc(length);
      buffer.writeUInt32BE(values[source.calls++] ?? 0, 0);
      return buffer;
    },
  };
  return source;
}

describe('sha256Hex', () => {
  test('is the lowercase hex digest', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('constantTimeEqual', () => {
  test('equal strings match; different content or length does not', () => {
    expect(constantTimeEqual('secret-token', 'secret-token')).toBe(true);
    expect(constantTimeEqual('secret-token', 'secret-tokeN')).toBe(false);
    expect(constantTimeEqual('secret-token', 'secret-token-longer')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('generateDeviceToken', () => {
  test('is 256 bits of the random source, base64url', () => {
    const token = generateDeviceToken(createCountingRandom());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toEqual(
      Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)),
    );
  });

  test('two tokens differ', () => {
    expect(generateDeviceToken(systemRandom)).not.toBe(generateDeviceToken(systemRandom));
  });
});

describe('generatePairingCode', () => {
  test('is eight digits, zero-padded', () => {
    expect(generatePairingCode(scripted([42]))).toBe('00000042');
    expect(generatePairingCode(scripted([123_456_789]))).toBe('23456789');
  });

  test('values that would bias the distribution are drawn again', () => {
    // 2^32 holds 42 full ranges of 10^8; anything from 4_200_000_000 up is rejected.
    const random = scripted([4_200_000_000, 4_294_967_295, 4_199_999_999]);
    expect(generatePairingCode(random)).toBe('99999999');
    expect(random.calls).toBe(3);
  });

  test('every code satisfies the protocol schema', () => {
    for (let index = 0; index < 200; index++) {
      expect(PairingCodeValueSchema.safeParse(generatePairingCode(systemRandom)).success).toBe(
        true,
      );
    }
  });
});

describe('formatPairingCode', () => {
  test('shows the code in two groups', () => {
    expect(formatPairingCode('12345678')).toBe('1234 5678');
  });
});
