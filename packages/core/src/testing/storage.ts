import type { DeviceRecord, PairingCodeRecord, SecretStore, Storage } from '../contracts/index.ts';
import { HISTORY_PREVIEW_CHARS, isTerminalSlotStatus } from '../protocol/index.ts';
import type { AskSnapshot, HistoryItem, Preset } from '../protocol/index.ts';

const copy = <T>(value: T): T => structuredClone(value);

function toHistoryItem(turn: AskSnapshot): HistoryItem {
  return {
    askId: turn.askId,
    conversationId: turn.conversationId,
    promptPreview: turn.prompt.slice(0, HISTORY_PREVIEW_CHARS),
    createdAt: turn.createdAt,
    slots: turn.slots.map(({ slotId, providerId, kind, model, status }) => ({
      slotId,
      providerId,
      kind,
      status,
      ...(model === undefined ? {} : { model }),
    })),
  };
}

const sizeOf = (turn: AskSnapshot): number =>
  turn.prompt.length + turn.slots.reduce((sum, s) => sum + s.text.length + s.reasoning.length, 0);

/**
 * In-memory `Storage` with the same observable behaviour as the real one.
 * Values are copied on the way in and out, as a database would. The cursor
 * is the number of rows already returned.
 */
export function createFakeStorage(): Storage {
  const turns = new Map<string, AskSnapshot>();
  const presets = new Map<string, Preset>();
  const devices = new Map<string, DeviceRecord>();
  const pairingCodes = new Map<string, PairingCodeRecord>();
  let settingsDocument: unknown;

  const newestFirst = () => [...turns.values()].sort((a, b) => b.createdAt - a.createdAt);

  return {
    turns: {
      async create(snapshot) {
        turns.set(snapshot.askId, copy(snapshot));
      },
      async conversationExists(conversationId) {
        return [...turns.values()].some((turn) => turn.conversationId === conversationId);
      },
      async save(snapshot, dirtySlotIds) {
        const stored = turns.get(snapshot.askId);
        if (!stored) return;
        stored.status = snapshot.status;
        stored.seq = snapshot.seq;
        stored.slots = stored.slots.map((slot) => {
          const dirty = !dirtySlotIds || dirtySlotIds.includes(slot.slotId);
          const updated = snapshot.slots.find((candidate) => candidate.slotId === slot.slotId);
          return dirty && updated ? copy(updated) : slot;
        });
      },
      async failInterrupted(error) {
        let changed = 0;
        for (const turn of turns.values()) {
          if (turn.status === 'done') continue;
          for (const slot of turn.slots) {
            if (isTerminalSlotStatus(slot.status)) continue;
            slot.status = 'error';
            slot.error = { ...error };
            changed++;
          }
          turn.status = 'done';
        }
        return changed;
      },
      async get(askId) {
        const turn = turns.get(askId);
        return turn ? copy(turn) : null;
      },
      async list({ q, cursor, limit }) {
        const needle = q?.toLowerCase();
        const matches = newestFirst().filter(
          (turn) => needle === undefined || turn.prompt.toLowerCase().includes(needle),
        );
        const offset = cursor === undefined ? 0 : Number(cursor);
        const end = offset + limit;
        return {
          items: matches.slice(offset, end).map(toHistoryItem),
          nextCursor: end < matches.length ? String(end) : null,
        };
      },
      async delete(askId) {
        const turn = turns.get(askId);
        if (!turn) return 'not_found';
        if (turn.status !== 'done') return 'in_progress';
        turns.delete(askId);
        return 'deleted';
      },
      async prune({ maxAsks, maxBytes }) {
        const finished = newestFirst().filter((turn) => turn.status === 'done');
        let bytes = 0;
        let deleted = 0;
        finished.forEach((turn, index) => {
          bytes += sizeOf(turn);
          if (index >= maxAsks || bytes > maxBytes) {
            turns.delete(turn.askId);
            deleted++;
          }
        });
        return deleted;
      },
    },
    presets: {
      async list() {
        return [...presets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy);
      },
      async get(id) {
        const preset = presets.get(id);
        return preset ? copy(preset) : null;
      },
      async put(preset) {
        presets.set(preset.id, copy(preset));
      },
      async delete(id) {
        return presets.delete(id);
      },
    },
    settings: {
      async load() {
        return copy(settingsDocument);
      },
      async save(document) {
        settingsDocument = copy(document);
      },
    },
    devices: {
      async list() {
        return [...devices.values()].sort((a, b) => a.createdAt - b.createdAt).map(copy);
      },
      async findByTokenHash(tokenHash) {
        const device = [...devices.values()].find((d) => d.tokenHash === tokenHash);
        return device ? copy(device) : null;
      },
      async insert(device) {
        devices.set(device.id, copy(device));
      },
      async touch(id, lastUsedAt) {
        const device = devices.get(id);
        if (device) device.lastUsedAt = lastUsedAt;
      },
      async delete(id) {
        return devices.delete(id);
      },
    },
    pairingCodes: {
      async list() {
        return [...pairingCodes.values()].map(copy);
      },
      async insert(code) {
        pairingCodes.set(code.id, copy(code));
      },
      async setFailedAttempts(id, failedAttempts) {
        const code = pairingCodes.get(id);
        if (code) code.failedAttempts = failedAttempts;
      },
      async delete(id) {
        return pairingCodes.delete(id);
      },
    },
    async close() {},
  };
}

export function createFakeSecretStore(initial: Record<string, string> = {}): SecretStore {
  const secrets = new Map(Object.entries(initial));
  return {
    async get(key) {
      return secrets.get(key);
    },
    async set(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    },
  };
}
