import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type {
  AuthContext,
  AuthService,
  Clock,
  DeviceRecord,
  IdGenerator,
  Logger,
  PairingCodeRecord,
  RandomSource,
  Storage,
} from '../contracts/index.ts';
import { MAX_DEVICES, PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS } from '../protocol/index.ts';
import type { DeploymentMode, Device } from '../protocol/index.ts';
import {
  constantTimeEqual,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  sha256Hex,
} from './tokens.ts';

/** `lastUsedAt` is written at most this often per device, not on every request. */
export const LAST_USED_INTERVAL_MS = 5 * 60_000;
/** Unused pairing codes kept at once; creating more drops the ones closest to expiry. */
export const MAX_PAIRING_CODES = 8;
/** Bounds of the static token; the upper one is what `POST /api/auth/session` accepts. */
export const STATIC_TOKEN_MIN_LENGTH = 16;
export const STATIC_TOKEN_MAX_LENGTH = 512;

export interface AuthServiceDeps {
  storage: Storage;
  clock: Clock;
  ids: IdGenerator;
  random: RandomSource;
  logger: Logger;
  /** `bootstrap` logs a first pairing code only in server mode. */
  mode: DeploymentMode;
  /**
   * The automation token in server mode. In desktop mode the token the shell
   * generated for this launch, which is then the only way in: no device can
   * be paired and no stored device token is accepted.
   */
  staticToken: string | undefined;
}

const toDevice = (record: DeviceRecord, caller: AuthContext | null): Device => ({
  id: record.id,
  name: record.name,
  createdAt: record.createdAt,
  lastUsedAt: record.lastUsedAt,
  current: caller?.kind === 'device' && caller.deviceId === record.id,
});

/**
 * @throws Error when the configuration leaves no usable way to sign in: a
 *   static token outside its length bounds, or desktop mode without one.
 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { storage, clock, ids, random, logger, mode, staticToken } = deps;

  if (
    staticToken !== undefined &&
    (staticToken.length < STATIC_TOKEN_MIN_LENGTH || staticToken.length > STATIC_TOKEN_MAX_LENGTH)
  ) {
    throw new Error(
      `The static token must be ${STATIC_TOKEN_MIN_LENGTH} to ${STATIC_TOKEN_MAX_LENGTH} characters long`,
    );
  }
  if (mode === 'desktop' && staticToken === undefined) {
    throw new Error('Desktop mode needs a per-launch token');
  }

  const pairingAllowed = mode === 'server';
  const requirePairing = (): void => {
    if (!pairingAllowed) {
      throw new AppError('forbidden', 'Devices can be paired in server mode only');
    }
  };

  /** When each device's `lastUsedAt` was last written by this process. */
  const touched = new Map<string, number>();

  /** Pairing attempts run one at a time, so the attempt counters cannot be raced. */
  let pairingQueue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(task: () => Promise<T>): Promise<T> => {
    const result = pairingQueue.then(task, task);
    pairingQueue = result.catch(() => undefined);
    return result;
  };

  const isLive = (code: PairingCodeRecord, now: number): boolean =>
    code.expiresAt > now && code.failedAttempts < PAIRING_MAX_ATTEMPTS;

  /** The codes that can still be used; expired and voided ones are removed on the way. */
  const liveCodes = async (): Promise<PairingCodeRecord[]> => {
    const now = clock.now();
    const live: PairingCodeRecord[] = [];
    for (const code of await storage.pairingCodes.list()) {
      if (isLive(code, now)) live.push(code);
      else await storage.pairingCodes.delete(code.id);
    }
    return live;
  };

  const recordUse = async (device: DeviceRecord): Promise<void> => {
    const now = clock.now();
    const last = Math.max(device.lastUsedAt ?? -Infinity, touched.get(device.id) ?? -Infinity);
    if (now - last < LAST_USED_INTERVAL_MS) return;
    touched.set(device.id, now);
    await storage.devices.touch(device.id, now);
  };

  const forget = async (deviceId: string): Promise<boolean> => {
    touched.delete(deviceId);
    return storage.devices.delete(deviceId);
  };

  const createPairingCode = async () => {
    requirePairing();
    const live = await liveCodes();
    const excess = live
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .slice(0, Math.max(0, live.length - (MAX_PAIRING_CODES - 1)));
    for (const code of excess) await storage.pairingCodes.delete(code.id);

    const code = generatePairingCode(random);
    const expiresAt = clock.now() + PAIRING_CODE_TTL_MS;
    await storage.pairingCodes.insert({
      id: ids.next(),
      codeHash: sha256Hex(code),
      expiresAt,
      failedAttempts: 0,
    });
    return { code, expiresAt };
  };

  return {
    async authenticate(token) {
      if (token.length > STATIC_TOKEN_MAX_LENGTH) return null;
      if (staticToken !== undefined && constantTimeEqual(token, staticToken)) {
        return { kind: 'static-token' };
      }
      if (!pairingAllowed) return null;
      const tokenHash = sha256Hex(token);
      const device = await storage.devices.findByTokenHash(tokenHash);
      if (!device || !constantTimeEqual(device.tokenHash, tokenHash)) return null;
      await recordUse(device);
      return { kind: 'device', deviceId: device.id };
    },

    pair: ({ code, deviceName }) =>
      serialised(async () => {
        requirePairing();
        const live = await liveCodes();
        const codeHash = sha256Hex(code);
        // Every live code is compared, so timing does not tell which one matched.
        let match: PairingCodeRecord | undefined;
        for (const candidate of live) {
          if (constantTimeEqual(candidate.codeHash, codeHash)) match ??= candidate;
        }

        if (!match) {
          // A wrong guess counts against every code it could have been aimed at.
          for (const candidate of live) {
            const failedAttempts = candidate.failedAttempts + 1;
            if (failedAttempts >= PAIRING_MAX_ATTEMPTS) {
              await storage.pairingCodes.delete(candidate.id);
            } else {
              await storage.pairingCodes.setFailedAttempts(candidate.id, failedAttempts);
            }
          }
          throw new AppError('invalid_code', 'Wrong or expired pairing code');
        }

        // Checked before the code is consumed: after revoking a device the same code still works.
        if ((await storage.devices.list()).length >= MAX_DEVICES) {
          throw new AppError('device_limit', `At most ${MAX_DEVICES} devices can be paired`);
        }
        // The single-use claim: only the caller that deletes the code may use it.
        if (!(await storage.pairingCodes.delete(match.id))) {
          throw new AppError('invalid_code', 'Wrong or expired pairing code');
        }

        const token = generateDeviceToken(random);
        const record: DeviceRecord = {
          id: ids.next(),
          name: deviceName,
          tokenHash: sha256Hex(token),
          createdAt: clock.now(),
          lastUsedAt: null,
        };
        await storage.devices.insert(record);
        logger.info('device paired', { deviceId: record.id });
        return { token, device: { ...toDevice(record, null), current: true } };
      }),

    createPairingCode,

    async bootstrap() {
      if (!pairingAllowed) return;
      if ((await storage.devices.list()).length > 0) return;
      const { code } = await createPairingCode();
      // The one secret that is meant to be logged. It is written in two
      // groups, which is easier to read and is not what the log masks.
      logger.info(
        `No device is paired yet. Pair the first device with this one-time code: ${formatPairingCode(code)}`,
        {
          validForMinutes: PAIRING_CODE_TTL_MS / 60_000,
          hint: `run "${BRAND.cliName} pair" for a new code`,
        },
      );
    },

    async listDevices(caller) {
      return (await storage.devices.list()).map((record) => toDevice(record, caller));
    },

    async getDevice(caller) {
      if (caller.kind !== 'device') return null;
      const record = (await storage.devices.list()).find((d) => d.id === caller.deviceId);
      return record ? toDevice(record, caller) : null;
    },

    async revokeDevice(deviceId) {
      const revoked = await forget(deviceId);
      if (revoked) logger.info('device revoked', { deviceId });
      return revoked;
    },

    async logout(caller) {
      if (caller.kind === 'device') await forget(caller.deviceId);
    },
  };
}
