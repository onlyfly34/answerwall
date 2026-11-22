import { AppError } from '../contracts/index.ts';
import type { AuthContext, AuthService, Clock, IdGenerator } from '../contracts/index.ts';
import { MAX_DEVICES, PAIRING_CODE_TTL_MS } from '../protocol/index.ts';
import type { Device } from '../protocol/index.ts';

export const TEST_TOKEN = 'test-token-0123456789abcdef';
export const TEST_PAIRING_CODE = '12345678';

/**
 * An `AuthService` with fixed credentials and no hashing, expiry or attempt
 * counting: {@link TEST_TOKEN} is the static token, {@link TEST_PAIRING_CODE}
 * always pairs, and a paired device's token is `token-<deviceId>`.
 */
export function createFakeAuthService(deps: { clock: Clock; ids: IdGenerator }): AuthService {
  const devices = new Map<string, Omit<Device, 'current'>>();
  const describe = (caller: AuthContext): Device[] =>
    [...devices.values()].map((device) => ({
      ...device,
      current: caller.kind === 'device' && caller.deviceId === device.id,
    }));

  return {
    async authenticate(token) {
      if (token === TEST_TOKEN) return { kind: 'static-token' };
      const device = devices.get(token.replace(/^token-/, ''));
      if (!device || token !== `token-${device.id}`) return null;
      device.lastUsedAt = deps.clock.now();
      return { kind: 'device', deviceId: device.id };
    },
    async pair({ code, deviceName }) {
      if (code !== TEST_PAIRING_CODE) throw new AppError('invalid_code', 'Wrong pairing code');
      if (devices.size >= MAX_DEVICES) {
        throw new AppError('device_limit', `At most ${MAX_DEVICES} devices can be paired`);
      }
      const device = {
        id: deps.ids.next(),
        name: deviceName,
        createdAt: deps.clock.now(),
        lastUsedAt: null,
      };
      devices.set(device.id, device);
      return { token: `token-${device.id}`, device: { ...device, current: true } };
    },
    async createPairingCode() {
      return { code: TEST_PAIRING_CODE, expiresAt: deps.clock.now() + PAIRING_CODE_TTL_MS };
    },
    async bootstrap() {},
    async listDevices(caller) {
      return describe(caller);
    },
    async getDevice(caller) {
      return describe(caller).find((device) => device.current) ?? null;
    },
    async revokeDevice(deviceId) {
      return devices.delete(deviceId);
    },
    async logout(caller) {
      if (caller.kind === 'device') devices.delete(caller.deviceId);
    },
  };
}
