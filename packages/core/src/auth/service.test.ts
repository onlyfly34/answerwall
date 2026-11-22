import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../contracts/index.ts';
import type { AuthContext, AuthService, Storage } from '../contracts/index.ts';
import {
  MAX_DEVICES,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PairingCodeValueSchema,
} from '../protocol/index.ts';
import type { DeploymentMode } from '../protocol/index.ts';
import { systemRandom } from '../system.ts';
import {
  createFakeStorage,
  createMemoryLogger,
  createSequentialIds,
  FakeClock,
} from '../testing/index.ts';
import { createAuthService, LAST_USED_INTERVAL_MS, MAX_PAIRING_CODES } from './service.ts';
import { sha256Hex } from './tokens.ts';

const STATIC_TOKEN = 'automation-token-0123456789';
const LAUNCH_TOKEN = 'launch-token-0123456789abcdef';

let storage: Storage;
let clock: FakeClock;
let logger: ReturnType<typeof createMemoryLogger>;
let auth: AuthService;

function service(
  options: { mode?: DeploymentMode; staticToken?: string | undefined } = {},
): AuthService {
  return createAuthService({
    storage,
    clock,
    ids: createSequentialIds(),
    random: systemRandom,
    logger,
    mode: options.mode ?? 'server',
    staticToken: options.staticToken,
  });
}

beforeEach(() => {
  storage = createFakeStorage();
  clock = new FakeClock();
  logger = createMemoryLogger();
  auth = service();
});

async function pairDevice(name = 'Phone', via: AuthService = auth) {
  const { code } = await via.createPairingCode();
  return via.pair({ code, deviceName: name });
}

/** A code that is certainly not `code`. */
const wrongFor = (code: string): string => (code === '00000000' ? '11111111' : '00000000');

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

describe('pairing', () => {
  test('a pairing code is eight digits and valid for five minutes', async () => {
    const { code, expiresAt } = await auth.createPairingCode();
    expect(PairingCodeValueSchema.safeParse(code).success).toBe(true);
    expect(expiresAt).toBe(clock.now() + PAIRING_CODE_TTL_MS);
  });

  test('a code pairs a device whose token then authenticates', async () => {
    const { token, device } = await pairDevice('Tablet');

    expect(device).toEqual({
      id: expect.any(String) as string,
      name: 'Tablet',
      createdAt: clock.now(),
      lastUsedAt: null,
      current: true,
    });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(await auth.authenticate(token)).toEqual({ kind: 'device', deviceId: device.id });
  });

  test('only hashes are stored: neither the code nor the token is in the database', async () => {
    const { code } = await auth.createPairingCode();
    expect(await storage.pairingCodes.list()).toEqual([
      expect.objectContaining({ codeHash: sha256Hex(code), failedAttempts: 0 }),
    ]);

    const { token } = await auth.pair({ code, deviceName: 'Phone' });
    const stored = JSON.stringify([
      await storage.devices.list(),
      await storage.pairingCodes.list(),
    ]);
    expect(stored).toContain(sha256Hex(token));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(code);
  });

  test('neither the code nor the token reaches the log when a device is paired', async () => {
    const { code } = await auth.createPairingCode();
    const { token, device } = await auth.pair({ code, deviceName: 'Phone' });

    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain(device.id);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(code);
  });

  test('a code works once', async () => {
    const { code } = await auth.createPairingCode();
    await auth.pair({ code, deviceName: 'First' });

    const error = await rejection(auth.pair({ code, deviceName: 'Second' }));
    expect(error.code).toBe('invalid_code');
    expect(await storage.devices.list()).toHaveLength(1);
  });

  test('two requests racing for one code pair exactly one device', async () => {
    const { code } = await auth.createPairingCode();

    const results = await Promise.allSettled([
      auth.pair({ code, deviceName: 'A' }),
      auth.pair({ code, deviceName: 'B' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await storage.devices.list()).toHaveLength(1);
  });

  test('a code is valid until its last millisecond and void after', async () => {
    const early = await auth.createPairingCode();
    await clock.advance(PAIRING_CODE_TTL_MS - 1);
    await expect(auth.pair({ code: early.code, deviceName: 'In time' })).resolves.toBeDefined();

    const late = await auth.createPairingCode();
    await clock.advance(PAIRING_CODE_TTL_MS);
    expect((await rejection(auth.pair({ code: late.code, deviceName: 'Late' }))).code).toBe(
      'invalid_code',
    );
    // Expired codes are removed when they are met.
    expect(await storage.pairingCodes.list()).toEqual([]);
  });

  test('wrong attempts are counted in storage and the right code still works before the limit', async () => {
    const { code } = await auth.createPairingCode();
    for (let attempt = 1; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
      const error = await rejection(auth.pair({ code: wrongFor(code), deviceName: 'Guess' }));
      expect(error.code).toBe('invalid_code');
      expect((await storage.pairingCodes.list())[0]?.failedAttempts).toBe(attempt);
    }

    await expect(auth.pair({ code, deviceName: 'Owner' })).resolves.toBeDefined();
  });

  test('a code is void after five wrong attempts, even for the right code', async () => {
    const { code } = await auth.createPairingCode();
    for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
      await rejection(auth.pair({ code: wrongFor(code), deviceName: 'Guess' }));
    }

    expect(await storage.pairingCodes.list()).toEqual([]);
    expect((await rejection(auth.pair({ code, deviceName: 'Owner' }))).code).toBe('invalid_code');
    expect(await storage.devices.list()).toEqual([]);
  });

  test('attempts counted by an earlier process still count', async () => {
    const { code } = await auth.createPairingCode();
    const [record] = await storage.pairingCodes.list();
    await storage.pairingCodes.setFailedAttempts(record?.id ?? '', PAIRING_MAX_ATTEMPTS - 1);

    await rejection(service().pair({ code: wrongFor(code), deviceName: 'Guess' }));

    expect((await rejection(auth.pair({ code, deviceName: 'Owner' }))).code).toBe('invalid_code');
  });

  test('a wrong attempt without any live code fails the same way', async () => {
    expect((await rejection(auth.pair({ code: '12345678', deviceName: 'Guess' }))).code).toBe(
      'invalid_code',
    );
  });

  test('a code created by a second process works on the running service', async () => {
    const otherProcess = service();
    const { code } = await otherProcess.createPairingCode();

    const { token } = await auth.pair({ code, deviceName: 'Phone' });

    expect(await auth.authenticate(token)).not.toBeNull();
  });

  test('earlier unused codes stay valid when a new one is created', async () => {
    const first = await auth.createPairingCode();
    const second = await auth.createPairingCode();

    await expect(auth.pair({ code: second.code, deviceName: 'B' })).resolves.toBeDefined();
    await expect(auth.pair({ code: first.code, deviceName: 'A' })).resolves.toBeDefined();
  });

  test('the number of unused codes is bounded: the one closest to expiry goes first', async () => {
    const first = await auth.createPairingCode();
    for (let index = 0; index < MAX_PAIRING_CODES; index++) {
      await clock.advance(1000);
      await auth.createPairingCode();
    }

    const stored = await storage.pairingCodes.list();
    expect(stored).toHaveLength(MAX_PAIRING_CODES);
    expect(stored.map((code) => code.codeHash)).not.toContain(sha256Hex(first.code));
  });
});

describe('device cap', () => {
  test('a ninth device is refused and the code survives until a device is revoked', async () => {
    const paired = [];
    for (let index = 0; index < MAX_DEVICES; index++) {
      paired.push(await pairDevice(`Device ${index}`));
    }
    const { code } = await auth.createPairingCode();

    const error = await rejection(auth.pair({ code, deviceName: 'One too many' }));
    expect(error.code).toBe('device_limit');
    expect(await storage.devices.list()).toHaveLength(MAX_DEVICES);

    expect(await auth.revokeDevice(paired[0]?.device.id ?? '')).toBe(true);
    await expect(auth.pair({ code, deviceName: 'Replacement' })).resolves.toBeDefined();
    expect(await storage.devices.list()).toHaveLength(MAX_DEVICES);
  });
});

describe('devices', () => {
  test('lists every device oldest first and marks the caller', async () => {
    const first = await pairDevice('First');
    await clock.advance(1000);
    const second = await pairDevice('Second');
    const caller: AuthContext = { kind: 'device', deviceId: second.device.id };

    const devices = await auth.listDevices(caller);

    expect(devices.map(({ name, current }) => ({ name, current }))).toEqual([
      { name: 'First', current: false },
      { name: 'Second', current: true },
    ]);
    expect(JSON.stringify(devices)).not.toContain('tokenHash');
    expect(await auth.getDevice(caller)).toMatchObject({ id: second.device.id, current: true });
    expect(await auth.getDevice({ kind: 'device', deviceId: first.device.id })).toMatchObject({
      name: 'First',
    });
  });

  test('the static token is nobody in the device list', async () => {
    await pairDevice();
    const caller: AuthContext = { kind: 'static-token' };

    expect((await auth.listDevices(caller)).every((device) => !device.current)).toBe(true);
    expect(await auth.getDevice(caller)).toBeNull();
  });

  test('a revoked device can no longer authenticate', async () => {
    const { token, device } = await pairDevice();

    expect(await auth.revokeDevice(device.id)).toBe(true);

    expect(await auth.authenticate(token)).toBeNull();
    expect(await auth.getDevice({ kind: 'device', deviceId: device.id })).toBeNull();
    expect(await auth.revokeDevice(device.id)).toBe(false);
  });

  test('revoking an unknown device reports that there is none', async () => {
    expect(await auth.revokeDevice('no-such-device')).toBe(false);
  });

  test('logout revokes the caller and nobody else', async () => {
    const first = await pairDevice('First');
    const second = await pairDevice('Second');

    await auth.logout({ kind: 'device', deviceId: first.device.id });

    expect(await auth.authenticate(first.token)).toBeNull();
    expect(await auth.authenticate(second.token)).not.toBeNull();
  });

  test('logout with the static token changes nothing', async () => {
    auth = service({ staticToken: STATIC_TOKEN });
    await pairDevice();

    await auth.logout({ kind: 'static-token' });

    expect(await storage.devices.list()).toHaveLength(1);
    expect(await auth.authenticate(STATIC_TOKEN)).toEqual({ kind: 'static-token' });
  });
});

describe('authenticate', () => {
  test.each(['', 'x', 'unknown-token-0123456789abcdef', 'A'.repeat(43), 'B'.repeat(10_000)])(
    'an unknown token (%#) is rejected',
    async (token) => {
      await pairDevice();
      expect(await auth.authenticate(token)).toBeNull();
    },
  );

  test('a token hash is not a token', async () => {
    const { token } = await pairDevice();
    expect(await auth.authenticate(sha256Hex(token))).toBeNull();
  });

  test('last use is recorded on first use, then at most once per interval', async () => {
    const { token, device } = await pairDevice();
    let writes = 0;
    const touch = storage.devices.touch.bind(storage.devices);
    storage.devices.touch = async (id, lastUsedAt) => {
      writes++;
      await touch(id, lastUsedAt);
    };
    const lastUsedAt = async () =>
      (await storage.devices.list()).find((record) => record.id === device.id)?.lastUsedAt;

    await auth.authenticate(token);
    const firstUse = clock.now();
    expect(await lastUsedAt()).toBe(firstUse);

    for (let index = 0; index < 20; index++) {
      await clock.advance(1000);
      await auth.authenticate(token);
    }
    expect(writes).toBe(1);
    expect(await lastUsedAt()).toBe(firstUse);

    await clock.advance(LAST_USED_INTERVAL_MS);
    await auth.authenticate(token);
    expect(writes).toBe(2);
    expect(await lastUsedAt()).toBe(clock.now());
  });

  test('a restarted service does not write again within the interval', async () => {
    const { token } = await pairDevice();
    await auth.authenticate(token);
    const [before] = await storage.devices.list();

    await clock.advance(LAST_USED_INTERVAL_MS - 1);
    await service().authenticate(token);

    expect((await storage.devices.list())[0]?.lastUsedAt).toBe(before?.lastUsedAt);
  });
});

describe('static token', () => {
  test('authenticates when configured and only with the exact value', async () => {
    auth = service({ staticToken: STATIC_TOKEN });

    expect(await auth.authenticate(STATIC_TOKEN)).toEqual({ kind: 'static-token' });
    expect(await auth.authenticate(`${STATIC_TOKEN}x`)).toBeNull();
    expect(await auth.authenticate(STATIC_TOKEN.slice(0, -1))).toBeNull();
    expect(await auth.authenticate(STATIC_TOKEN.toUpperCase())).toBeNull();
  });

  test('without one configured, nothing but a device token gets in', async () => {
    expect(await auth.authenticate(STATIC_TOKEN)).toBeNull();
    expect(await auth.authenticate('undefined')).toBeNull();
  });

  test.each([
    ['too short', 'short'],
    ['empty', ''],
    ['too long', 'x'.repeat(513)],
  ])('a %s static token is refused at start, without quoting it', (_label, staticToken) => {
    let message = '';
    try {
      service({ staticToken });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/static token must be 16 to 512 characters/);
    if (staticToken !== '') expect(message).not.toContain(staticToken);
  });
});

describe('first-device bootstrap', () => {
  const announcements = () =>
    logger.entries.filter((entry) => entry.message.includes('one-time code'));

  test('with no device paired, a usable code is written to the log', async () => {
    await auth.bootstrap();

    const [entry] = announcements();
    expect(entry?.level).toBe('info');
    const shown = /code: (\d{4} \d{4})$/.exec(entry?.message ?? '')?.[1] ?? '';
    await expect(
      auth.pair({ code: shown.replace(' ', ''), deviceName: 'First device' }),
    ).resolves.toBeDefined();
  });

  test('with a device paired, nothing is announced and no code is created', async () => {
    await pairDevice();
    logger.entries.length = 0;

    await auth.bootstrap();

    expect(announcements()).toEqual([]);
    expect(await storage.pairingCodes.list()).toEqual([]);
  });

  test('a static token does not replace the first pairing code', async () => {
    auth = service({ staticToken: STATIC_TOKEN });
    await auth.bootstrap();

    expect(announcements()).toHaveLength(1);
    expect(JSON.stringify(logger.entries)).not.toContain(STATIC_TOKEN);
  });
});

describe('desktop mode', () => {
  beforeEach(() => {
    auth = service({ mode: 'desktop', staticToken: LAUNCH_TOKEN });
  });

  test('needs a per-launch token', () => {
    expect(() => service({ mode: 'desktop' })).toThrow(/per-launch token/);
  });

  test('the launch token is the only way in', async () => {
    const device = await pairDevice('Paired in server mode', service());

    expect(await auth.authenticate(LAUNCH_TOKEN)).toEqual({ kind: 'static-token' });
    expect(await auth.authenticate(device.token)).toBeNull();
    expect(await auth.authenticate('launch-token-of-an-earlier-run')).toBeNull();
  });

  test('nothing is announced at start and no device can be paired', async () => {
    await auth.bootstrap();
    expect(logger.entries).toEqual([]);
    expect(await storage.pairingCodes.list()).toEqual([]);

    expect((await rejection(auth.createPairingCode())).code).toBe('forbidden');
    const { code } = await service().createPairingCode();
    expect((await rejection(auth.pair({ code, deviceName: 'Phone' }))).code).toBe('forbidden');
    expect(await storage.devices.list()).toEqual([]);
  });
});
