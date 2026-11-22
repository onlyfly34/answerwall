import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { DeviceRecord, PairingCodeRecord, Storage } from '../contracts/index.ts';
import { PresetSchema } from '../protocol/index.ts';
import type { Preset } from '../protocol/index.ts';
import { createMemoryLogger } from '../testing/index.ts';
import { IN_MEMORY, openConnection } from './connection.ts';
import { createSqliteStorage } from './index.ts';

let dir: string;
const opened: Storage[] = [];

const open = async (file = IN_MEMORY, logger = createMemoryLogger()): Promise<Storage> => {
  const storage = await createSqliteStorage({ file, logger });
  opened.push(storage);
  return storage;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storage-repositories-'));
});

afterEach(async () => {
  for (const storage of opened.splice(0)) await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const preset = (id: string, overrides: Partial<Preset> = {}): Preset => ({
  id,
  name: `Preset ${id}`,
  slots: [{ slotId: 'a', providerId: 'claude' }],
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const device = (id: string, overrides: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id,
  name: `Device ${id}`,
  tokenHash: id.padEnd(64, '0'),
  createdAt: 1000,
  lastUsedAt: null,
  ...overrides,
});

const code = (id: string, overrides: Partial<PairingCodeRecord> = {}): PairingCodeRecord => ({
  id,
  codeHash: id.padEnd(64, 'f'),
  expiresAt: 5000,
  failedAttempts: 0,
  ...overrides,
});

describe('presets', () => {
  test('a preset with targets and a layout survives the round trip', async () => {
    const { presets } = await open();
    const full = preset('full', {
      name: 'Everything 全部',
      slots: [
        { slotId: 'left', providerId: 'claude', model: 'opus', effort: 'high' },
        { slotId: 'right', providerId: 'local-llm' },
      ],
      layout: { mode: 'fixed', minCellWidth: 480, columns: 2 },
      createdAt: 1000,
      updatedAt: 2000,
    });

    await presets.put(full);

    expect(await presets.get('full')).toEqual(full);
    expect(PresetSchema.parse(await presets.get('full'))).toEqual(full);
  });

  test('a preset without a layout has no layout key', async () => {
    const { presets } = await open();
    await presets.put(preset('bare'));

    expect(await presets.get('bare')).toEqual(preset('bare'));
    expect(await presets.get('bare')).not.toHaveProperty('layout');
  });

  test('put replaces by id, including dropping the layout', async () => {
    const { presets } = await open();
    await presets.put(preset('p', { layout: { mode: 'auto', minCellWidth: 300, columns: 3 } }));

    const renamed = preset('p', { name: 'Renamed', updatedAt: 3000 });
    await presets.put(renamed);

    expect(await presets.list()).toEqual([renamed]);
  });

  test('the list is ordered by name, ignoring case, with the id as tie-break', async () => {
    const { presets } = await open();
    await presets.put(preset('3', { name: 'beta' }));
    await presets.put(preset('2', { name: 'Same' }));
    await presets.put(preset('1', { name: 'Same' }));
    await presets.put(preset('4', { name: 'Alpha' }));

    expect((await presets.list()).map((p) => p.id)).toEqual(['4', '3', '1', '2']);
  });

  test('delete reports whether the preset existed', async () => {
    const { presets } = await open();
    await presets.put(preset('p'));

    expect(await presets.delete('p')).toBe(true);
    expect(await presets.delete('p')).toBe(false);
    expect(await presets.get('p')).toBeNull();
    expect(await presets.list()).toEqual([]);
  });
});

describe('settings document', () => {
  test('is undefined until something is saved', async () => {
    const { settings } = await open();

    expect(await settings.load()).toBeUndefined();
  });

  test('stores any JSON value and replaces it on the next save', async () => {
    const { settings } = await open();

    await settings.save({ language: 'en', nested: { list: [1, 'two', null] } });
    expect(await settings.load()).toEqual({ language: 'en', nested: { list: [1, 'two', null] } });

    await settings.save(['now', 'an', 'array']);
    expect(await settings.load()).toEqual(['now', 'an', 'array']);

    await settings.save(null);
    expect(await settings.load()).toBeNull();
  });

  test('saving undefined removes the document', async () => {
    const { settings } = await open();
    await settings.save({ language: 'en' });

    await settings.save(undefined);

    expect(await settings.load()).toBeUndefined();
  });

  test('a document that is not JSON is ignored with a warning that does not quote it', async () => {
    const file = join(dir, 'damaged.sqlite');
    const logger = createMemoryLogger();
    const storage = await open(file, logger);
    const db = openConnection({ file });
    db.run('INSERT INTO settings (id, document) VALUES (1, ?)', '{"language": "en", oops');
    db.close();

    expect(await storage.settings.load()).toBeUndefined();

    const warnings = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain('oops');
  });
});

describe('devices', () => {
  test('lists oldest first and finds a device by its token hash', async () => {
    const { devices } = await open();
    await devices.insert(device('newer', { createdAt: 2000 }));
    await devices.insert(device('older', { createdAt: 1000, lastUsedAt: 1500 }));

    expect((await devices.list()).map((d) => d.id)).toEqual(['older', 'newer']);
    expect(await devices.findByTokenHash('older'.padEnd(64, '0'))).toEqual(
      device('older', { createdAt: 1000, lastUsedAt: 1500 }),
    );
    expect(await devices.findByTokenHash('unknown')).toBeNull();
  });

  test('devices created in the same millisecond keep their insertion order', async () => {
    const { devices } = await open();
    for (const id of ['c', 'a', 'b']) await devices.insert(device(id));

    expect((await devices.list()).map((d) => d.id)).toEqual(['c', 'a', 'b']);
  });

  test('touch records the last use; touching an unknown device does nothing', async () => {
    const { devices } = await open();
    await devices.insert(device('d'));

    await devices.touch('d', 4242);
    await devices.touch('ghost', 4242);

    expect(await devices.list()).toEqual([device('d', { lastUsedAt: 4242 })]);
  });

  test('delete revokes the device: its token hash no longer resolves', async () => {
    const { devices } = await open();
    await devices.insert(device('d'));

    expect(await devices.delete('d')).toBe(true);
    expect(await devices.delete('d')).toBe(false);
    expect(await devices.findByTokenHash('d'.padEnd(64, '0'))).toBeNull();
  });

  test('two devices cannot share an id or a token hash', async () => {
    const { devices } = await open();
    await devices.insert(device('d'));

    await expect(devices.insert(device('d', { tokenHash: 'other' }))).rejects.toThrow(/UNIQUE/);
    await expect(devices.insert(device('e', { tokenHash: 'd'.padEnd(64, '0') }))).rejects.toThrow(
      /UNIQUE/,
    );
    expect(await devices.list()).toHaveLength(1);
  });
});

describe('pairing codes', () => {
  test('insert, count failed attempts, list', async () => {
    const { pairingCodes } = await open();
    await pairingCodes.insert(code('one'));
    await pairingCodes.insert(code('two', { expiresAt: 9000 }));

    await pairingCodes.setFailedAttempts('one', 3);
    await pairingCodes.setFailedAttempts('ghost', 3);

    expect(await pairingCodes.list()).toEqual([
      code('one', { failedAttempts: 3 }),
      code('two', { expiresAt: 9000 }),
    ]);
  });

  test('delete is true exactly once', async () => {
    const { pairingCodes } = await open();
    await pairingCodes.insert(code('one'));

    expect(await pairingCodes.delete('one')).toBe(true);
    expect(await pairingCodes.delete('one')).toBe(false);
    expect(await pairingCodes.delete('never-existed')).toBe(false);
    expect(await pairingCodes.list()).toEqual([]);
  });
});

describe('a second connection on the same file', () => {
  test('a pairing code created through one connection is visible to the other at once', async () => {
    const file = join(dir, 'shared.sqlite');
    const server = await open(file);
    expect(await server.pairingCodes.list()).toEqual([]);

    const pairCommand = await open(file);
    await pairCommand.pairingCodes.insert(code('from-cli'));
    await pairCommand.close();

    expect(await server.pairingCodes.list()).toEqual([code('from-cli')]);
  });

  test('a code is claimed by exactly one of several connections', async () => {
    const file = join(dir, 'claim.sqlite');
    const connections = await Promise.all([open(file), open(file), open(file)]);
    await connections[0]?.pairingCodes.insert(code('single-use'));

    const claims = await Promise.all(
      connections.map((storage) => storage.pairingCodes.delete('single-use')),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test('failed attempts counted by one connection are seen by the other', async () => {
    const file = join(dir, 'attempts.sqlite');
    const first = await open(file);
    const second = await open(file);
    await first.pairingCodes.insert(code('c'));

    await second.pairingCodes.setFailedAttempts('c', 4);

    expect((await first.pairingCodes.list())[0]?.failedAttempts).toBe(4);
  });

  test('opening the file a second time neither migrates again nor disturbs the data', async () => {
    const file = join(dir, 'twice.sqlite');
    const first = await open(file);
    await first.devices.insert(device('d'));
    const logger = createMemoryLogger();

    const second = await open(file, logger);

    expect(logger.entries).toEqual([]);
    expect(await second.devices.list()).toEqual([device('d')]);
  });
});

describe('a second process on the same file', () => {
  /**
   * Stands in for the `pair` command at its slowest: another process that
   * holds the write lock for a while, inserts a pairing code and commits.
   */
  const HOLD_LOCK_SCRIPT = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      'INSERT INTO pairing_codes (id, code_hash, expires_at, failed_attempts) VALUES (?, ?, ?, ?)',
    ).run('from-other-process', 'hash', 5000, 0);
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    db.exec('COMMIT');
    db.close();
  `;

  test('a write waits for the other process to commit instead of failing', async () => {
    const file = join(dir, 'processes.sqlite');
    const server = await open(file);
    const child = spawn(process.execPath, ['-e', HOLD_LOCK_SCRIPT, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = once(child, 'exit');
    await once(child.stdout, 'data');

    // The other process holds the write lock right now.
    await server.pairingCodes.insert(code('from-server'));

    expect((await server.pairingCodes.list()).map((c) => c.id).sort()).toEqual([
      'from-other-process',
      'from-server',
    ]);
    expect(await server.pairingCodes.delete('from-other-process')).toBe(true);
    const [exitCode] = (await exited) as [number];
    expect(exitCode).toBe(0);
  });
});

test('a closed storage can be closed again', async () => {
  const storage = await createSqliteStorage({ file: IN_MEMORY, logger: createMemoryLogger() });

  await storage.close();

  await expect(storage.close()).resolves.toBeUndefined();
});
