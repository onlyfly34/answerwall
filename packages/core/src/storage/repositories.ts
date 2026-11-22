import type {
  DeviceRecord,
  DeviceRepository,
  Logger,
  PairingCodeRecord,
  PairingCodeRepository,
  PresetRepository,
  SettingsRepository,
} from '../contracts/index.ts';
import type { LayoutSettings, Preset } from '../protocol/index.ts';
import type { Connection } from './connection.ts';

interface PresetRow {
  id: string;
  name: string;
  slots_json: string;
  layout_json: string | null;
  created_at: number;
  updated_at: number;
}

function toPreset(row: PresetRow): Preset {
  return {
    id: row.id,
    name: row.name,
    slots: JSON.parse(row.slots_json) as Preset['slots'],
    ...(row.layout_json === null ? {} : { layout: JSON.parse(row.layout_json) as LayoutSettings }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PRESET_COLUMNS = 'id, name, slots_json, layout_json, created_at, updated_at';

export function createPresetRepository(db: Connection): PresetRepository {
  return {
    async list() {
      // Names are not unique; the id makes the order total.
      return db
        .all<PresetRow>(`SELECT ${PRESET_COLUMNS} FROM presets ORDER BY name COLLATE NOCASE, id`)
        .map(toPreset);
    },
    async get(id) {
      const row = db.get<PresetRow>(`SELECT ${PRESET_COLUMNS} FROM presets WHERE id = ?`, id);
      return row ? toPreset(row) : null;
    },
    async put(preset) {
      db.run(
        `INSERT INTO presets (${PRESET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, slots_json = excluded.slots_json,
           layout_json = excluded.layout_json, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
        preset.id,
        preset.name,
        JSON.stringify(preset.slots),
        preset.layout ? JSON.stringify(preset.layout) : null,
        preset.createdAt,
        preset.updatedAt,
      );
    },
    async delete(id) {
      return db.run('DELETE FROM presets WHERE id = ?', id) > 0;
    },
  };
}

export function createSettingsRepository(db: Connection, logger: Logger): SettingsRepository {
  return {
    async load() {
      const row = db.get<{ document: string }>('SELECT document FROM settings WHERE id = 1');
      if (!row) return undefined;
      try {
        return JSON.parse(row.document) as unknown;
      } catch {
        // The settings service falls back to defaults for a missing document.
        logger.warn('stored settings document is not valid JSON; ignoring it');
        return undefined;
      }
    },
    async save(document) {
      const json = JSON.stringify(document) as string | undefined;
      if (json === undefined) {
        db.run('DELETE FROM settings WHERE id = 1');
        return;
      }
      db.run(
        `INSERT INTO settings (id, document) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET document = excluded.document`,
        json,
      );
    },
  };
}

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
}

const toDevice = (row: DeviceRow): DeviceRecord => ({
  id: row.id,
  name: row.name,
  tokenHash: row.token_hash,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const DEVICE_COLUMNS = 'id, name, token_hash, created_at, last_used_at';

export function createDeviceRepository(db: Connection): DeviceRepository {
  return {
    async list() {
      return db
        .all<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM devices ORDER BY created_at, rowid`)
        .map(toDevice);
    },
    async findByTokenHash(tokenHash) {
      const row = db.get<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?`,
        tokenHash,
      );
      return row ? toDevice(row) : null;
    },
    async insert(device) {
      db.run(
        `INSERT INTO devices (${DEVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
        device.id,
        device.name,
        device.tokenHash,
        device.createdAt,
        device.lastUsedAt,
      );
    },
    async touch(id, lastUsedAt) {
      db.run('UPDATE devices SET last_used_at = ? WHERE id = ?', lastUsedAt, id);
    },
    async delete(id) {
      return db.run('DELETE FROM devices WHERE id = ?', id) > 0;
    },
  };
}

interface PairingCodeRow {
  id: string;
  code_hash: string;
  expires_at: number;
  failed_attempts: number;
}

export function createPairingCodeRepository(db: Connection): PairingCodeRepository {
  return {
    async list() {
      return db
        .all<PairingCodeRow>(
          'SELECT id, code_hash, expires_at, failed_attempts FROM pairing_codes ORDER BY rowid',
        )
        .map((row): PairingCodeRecord => ({
          id: row.id,
          codeHash: row.code_hash,
          expiresAt: row.expires_at,
          failedAttempts: row.failed_attempts,
        }));
    },
    async insert(code) {
      db.run(
        'INSERT INTO pairing_codes (id, code_hash, expires_at, failed_attempts) VALUES (?, ?, ?, ?)',
        code.id,
        code.codeHash,
        code.expiresAt,
        code.failedAttempts,
      );
    },
    async setFailedAttempts(id, failedAttempts) {
      db.run('UPDATE pairing_codes SET failed_attempts = ? WHERE id = ?', failedAttempts, id);
    },
    /**
     * The claim of a single-use code: SQLite serialises writers across
     * connections and processes, so of any number of concurrent deletes of
     * one row exactly one reports a change.
     */
    async delete(id) {
      return db.run('DELETE FROM pairing_codes WHERE id = ?', id) === 1;
    },
  };
}
