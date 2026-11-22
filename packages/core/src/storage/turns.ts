import type { SQLInputValue } from 'node:sqlite';
import type { TurnRepository } from '../contracts/index.ts';
import { HISTORY_PREVIEW_CHARS } from '../protocol/index.ts';
import type {
  AskSnapshot,
  HistoryItem,
  ProviderErrorCode,
  ProviderKind,
  SlotNotice,
  SlotSnapshot,
  SlotStatus,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import type { Connection } from './connection.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { containsPattern, searchSpellings } from './search.ts';

interface TurnRow {
  ord: number;
  id: string;
  conversation_id: string;
  created_at: number;
  status: AskSnapshot['status'];
  seq: number;
  prompt: string;
}

interface SlotRow {
  slot_id: string;
  provider_id: string;
  kind: ProviderKind;
  model: string | null;
  effort: string | null;
  status: SlotStatus;
  streaming: StreamingMode | null;
  error_code: ProviderErrorCode | null;
  error_message: string | null;
  truncated: number;
  notices_json: string;
  usage_json: string | null;
  started_at: number | null;
  elapsed_ms: number | null;
  text: string;
  reasoning: string;
}

type ListedTurnRow = Pick<TurnRow, 'ord' | 'id' | 'conversation_id' | 'created_at'> & {
  preview: string;
};
type ListedSlotRow = Pick<SlotRow, 'slot_id' | 'provider_id' | 'kind' | 'model' | 'status'>;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** What a slot counts towards the history byte budget: its answer and reasoning. */
const slotBytes = (slot: SlotSnapshot): number => utf8Bytes(slot.text) + utf8Bytes(slot.reasoning);

/** The columns `save` rewrites, in the order of `MUTABLE_SLOT_COLUMNS`. */
function mutableSlotValues(slot: SlotSnapshot): SQLInputValue[] {
  return [
    slot.status,
    slot.streaming ?? null,
    slot.error?.code ?? null,
    slot.error?.message ?? null,
    slot.truncated ? 1 : 0,
    JSON.stringify(slot.notices),
    slot.usage ? JSON.stringify(slot.usage) : null,
    slot.startedAt ?? null,
    slot.elapsedMs ?? null,
    slotBytes(slot),
    slot.text,
    slot.reasoning,
  ];
}

const MUTABLE_SLOT_COLUMNS = [
  'status',
  'streaming',
  'error_code',
  'error_message',
  'truncated',
  'notices_json',
  'usage_json',
  'started_at',
  'elapsed_ms',
  'size_bytes',
  'text',
  'reasoning',
] as const;

const INSERT_SLOT = `
  INSERT INTO slot_runs
    (turn_id, slot_id, position, provider_id, kind, model, effort, ${MUTABLE_SLOT_COLUMNS.join(', ')})
  VALUES (?, ?, ?, ?, ?, ?, ?, ${MUTABLE_SLOT_COLUMNS.map(() => '?').join(', ')})`;

const UPDATE_SLOT = `
  UPDATE slot_runs SET ${MUTABLE_SLOT_COLUMNS.map((column) => `${column} = ?`).join(', ')}
  WHERE turn_id = ? AND slot_id = ?`;

/** The turn's size is its prompt plus whatever its slots hold right now. */
const UPDATE_TURN = `
  UPDATE turns SET status = ?, seq = ?,
    size_bytes = ? + (SELECT COALESCE(SUM(size_bytes), 0) FROM slot_runs WHERE turn_id = turns.id)
  WHERE id = ?`;

const SELECT_SLOTS = `
  SELECT slot_id, provider_id, kind, model, effort, status, streaming, error_code, error_message,
    truncated, notices_json, usage_json, started_at, elapsed_ms, text, reasoning
  FROM slot_runs WHERE turn_id = ? ORDER BY position`;

/** A conversation goes with its last turn. */
const DELETE_CONVERSATION_IF_EMPTY = `
  DELETE FROM conversations
  WHERE id = ? AND NOT EXISTS (SELECT 1 FROM turns WHERE conversation_id = conversations.id)`;

/**
 * Finished turns from newest to oldest with a running count and byte total;
 * everything past either bound is surplus.
 */
const SELECT_SURPLUS = `
  SELECT id, conversation_id FROM (
    SELECT id, conversation_id, ROW_NUMBER() OVER newest_first AS place, SUM(size_bytes) OVER newest_first AS bytes
    FROM turns WHERE status = 'done'
    WINDOW newest_first AS (ORDER BY created_at DESC, ord DESC ROWS UNBOUNDED PRECEDING)
  ) WHERE place > ? OR bytes > ?`;

const MATCHES_SPELLING = `(t.prompt LIKE ? ESCAPE '\\' OR EXISTS (
  SELECT 1 FROM slot_runs s WHERE s.turn_id = t.id AND s.text LIKE ? ESCAPE '\\'))`;

function toSlotSnapshot(row: SlotRow): SlotSnapshot {
  return {
    slotId: row.slot_id,
    providerId: row.provider_id,
    kind: row.kind,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.effort === null ? {} : { effort: row.effort }),
    status: row.status,
    ...(row.streaming === null ? {} : { streaming: row.streaming }),
    text: row.text,
    reasoning: row.reasoning,
    notices: JSON.parse(row.notices_json) as SlotNotice[],
    truncated: row.truncated !== 0,
    ...(row.error_code === null
      ? {}
      : { error: { code: row.error_code, message: row.error_message ?? '' } }),
    ...(row.usage_json === null ? {} : { usage: JSON.parse(row.usage_json) as Usage }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.elapsed_ms === null ? {} : { elapsedMs: row.elapsed_ms }),
  };
}

function toHistoryItem(row: ListedTurnRow, slots: ListedSlotRow[]): HistoryItem {
  return {
    askId: row.id,
    conversationId: row.conversation_id,
    promptPreview: row.preview,
    createdAt: row.created_at,
    slots: slots.map((slot) => ({
      slotId: slot.slot_id,
      providerId: slot.provider_id,
      kind: slot.kind,
      ...(slot.model === null ? {} : { model: slot.model }),
      status: slot.status,
    })),
  };
}

/**
 * History search is a substring match (`LIKE`) over the prompt and the
 * answer texts. The bundled SQLite does have FTS5, but it does not fit:
 * its word tokenizers do not segment Chinese, the trigram tokenizer cannot
 * answer queries shorter than three characters (most Chinese words), and
 * either index would multiply the size of a history that is held to a byte
 * budget and be rewritten on every flush of a streaming answer. A scan is
 * bounded by that same budget.
 */
export function createTurnRepository(db: Connection): TurnRepository {
  /** Hands the pages freed by deleted turns back to the file system. */
  const releaseFreedPages = () => db.exec('PRAGMA incremental_vacuum');

  return {
    async create(snapshot) {
      db.transaction(() => {
        db.run(
          'INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)',
          snapshot.conversationId,
          snapshot.createdAt,
        );
        db.run(
          `INSERT INTO turns (id, conversation_id, created_at, status, seq, size_bytes, prompt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          snapshot.askId,
          snapshot.conversationId,
          snapshot.createdAt,
          snapshot.status,
          snapshot.seq,
          utf8Bytes(snapshot.prompt) + snapshot.slots.reduce((sum, s) => sum + slotBytes(s), 0),
          snapshot.prompt,
        );
        snapshot.slots.forEach((slot, position) => {
          db.run(
            INSERT_SLOT,
            snapshot.askId,
            slot.slotId,
            position,
            slot.providerId,
            slot.kind,
            slot.model ?? null,
            slot.effort ?? null,
            ...mutableSlotValues(slot),
          );
        });
      });
    },

    async conversationExists(conversationId) {
      return db.get('SELECT 1 FROM conversations WHERE id = ?', conversationId) !== undefined;
    },

    async save(snapshot, dirtySlotIds) {
      const dirty = dirtySlotIds && new Set(dirtySlotIds);
      db.transaction(() => {
        for (const slot of snapshot.slots) {
          if (dirty && !dirty.has(slot.slotId)) continue;
          db.run(UPDATE_SLOT, ...mutableSlotValues(slot), snapshot.askId, slot.slotId);
        }
        db.run(
          UPDATE_TURN,
          snapshot.status,
          snapshot.seq,
          utf8Bytes(snapshot.prompt),
          snapshot.askId,
        );
      });
    },

    async failInterrupted(error) {
      return db.transaction(() => {
        const changed = db.run(
          `UPDATE slot_runs SET status = 'error', error_code = ?, error_message = ?
           WHERE status IN ('queued', 'running')
             AND turn_id IN (SELECT id FROM turns WHERE status <> 'done')`,
          error.code,
          error.message,
        );
        db.run(`UPDATE turns SET status = 'done' WHERE status <> 'done'`);
        return changed;
      });
    },

    async get(askId) {
      const turn = db.get<TurnRow>(
        `SELECT ord, id, conversation_id, created_at, status, seq, prompt
         FROM turns WHERE id = ?`,
        askId,
      );
      if (!turn) return null;
      return {
        askId: turn.id,
        conversationId: turn.conversation_id,
        prompt: turn.prompt,
        createdAt: turn.created_at,
        status: turn.status,
        seq: turn.seq,
        slots: db.all<SlotRow>(SELECT_SLOTS, askId).map(toSlotSnapshot),
      };
    },

    async list({ q, cursor, limit }) {
      const conditions: string[] = [];
      const params: SQLInputValue[] = [HISTORY_PREVIEW_CHARS];
      if (cursor !== undefined) {
        const after = decodeCursor(cursor);
        conditions.push('(t.created_at, t.ord) < (?, ?)');
        params.push(after.createdAt, after.ord);
      }
      if (q !== undefined) {
        const patterns = searchSpellings(q).map(containsPattern);
        conditions.push(`(${patterns.map(() => MATCHES_SPELLING).join(' OR ')})`);
        for (const pattern of patterns) params.push(pattern, pattern);
      }
      // One row more than asked for tells whether another page exists.
      const rows = db.all<ListedTurnRow>(
        `SELECT t.ord, t.id, t.conversation_id, t.created_at, substr(t.prompt, 1, ?) AS preview
         FROM turns t ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY t.created_at DESC, t.ord DESC LIMIT ?`,
        ...params,
        limit + 1,
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) =>
          toHistoryItem(
            row,
            db.all<ListedSlotRow>(
              `SELECT slot_id, provider_id, kind, model, status
               FROM slot_runs WHERE turn_id = ? ORDER BY position`,
              row.id,
            ),
          ),
        ),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ createdAt: last.created_at, ord: last.ord })
            : null,
      };
    },

    async delete(askId) {
      const outcome = db.transaction(() => {
        const turn = db.get<Pick<TurnRow, 'status' | 'conversation_id'>>(
          'SELECT status, conversation_id FROM turns WHERE id = ?',
          askId,
        );
        if (!turn) return 'not_found';
        if (turn.status !== 'done') return 'in_progress';
        db.run('DELETE FROM turns WHERE id = ?', askId);
        db.run(DELETE_CONVERSATION_IF_EMPTY, turn.conversation_id);
        return 'deleted';
      });
      if (outcome === 'deleted') releaseFreedPages();
      return outcome;
    },

    async prune({ maxAsks, maxBytes }) {
      const deleted = db.transaction(() => {
        const surplus = db.all<Pick<TurnRow, 'id' | 'conversation_id'>>(
          SELECT_SURPLUS,
          maxAsks,
          maxBytes,
        );
        for (const turn of surplus) {
          db.run('DELETE FROM turns WHERE id = ?', turn.id);
          db.run(DELETE_CONVERSATION_IF_EMPTY, turn.conversation_id);
        }
        return surplus.length;
      });
      if (deleted > 0) releaseFreedPages();
      return deleted;
    },
  };
}
