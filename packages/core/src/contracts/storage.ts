import type {
  AskSnapshot,
  HistoryPage,
  HistoryQuery,
  Preset,
  SlotError,
} from '../protocol/index.ts';

/**
 * The `conversations 1—N turns 1—N slot_runs` aggregate. An ask is one turn;
 * its id is the turn id. Reads and writes use the protocol's `AskSnapshot`,
 * so storage and the stream share one shape.
 */
export interface TurnRepository {
  /** Inserts the turn and its slot runs, and the conversation when it does not exist yet. */
  create(snapshot: AskSnapshot): Promise<void>;
  conversationExists(conversationId: string): Promise<boolean>;
  /**
   * Writes the mutable state: the ask's status and seq, and per slot every
   * `SlotSnapshot` field except `slotId`, `providerId`, `kind`, `model` and
   * `effort` (which never change after `create`). All slots, or only
   * `dirtySlotIds`.
   */
  save(snapshot: AskSnapshot, dirtySlotIds?: readonly string[]): Promise<void>;
  /**
   * Ends every turn that is not done: its queued and running slots become
   * `error` with the given error. Returns the number of slots changed.
   */
  failInterrupted(error: SlotError): Promise<number>;
  get(askId: string): Promise<AskSnapshot | null>;
  /**
   * Newest first; rows carry no answer bodies. `q` matches the prompt or an
   * answer, case-insensitively.
   * @throws AppError `bad_request` for a cursor this repository did not issue
   */
  list(query: HistoryQuery): Promise<HistoryPage>;
  /** Deletes a finished turn, and its conversation when that was its last turn. */
  delete(askId: string): Promise<'deleted' | 'not_found' | 'in_progress'>;
  /** Deletes the oldest finished turns until both bounds hold. Returns how many were deleted. */
  prune(bounds: { maxAsks: number; maxBytes: number }): Promise<number>;
}

export interface PresetRepository {
  /** Ordered by name. */
  list(): Promise<Preset[]>;
  get(id: string): Promise<Preset | null>;
  /** Insert or replace by id. */
  put(preset: Preset): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** The settings document, stored as one opaque JSON value; `SettingsService` validates it. */
export interface SettingsRepository {
  load(): Promise<unknown>;
  save(document: unknown): Promise<void>;
}

export interface DeviceRecord {
  id: string;
  name: string;
  /** Lowercase hex SHA-256 of the device token; the token itself is never stored. */
  tokenHash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface DeviceRepository {
  /** Oldest first. */
  list(): Promise<DeviceRecord[]>;
  findByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  insert(device: DeviceRecord): Promise<void>;
  touch(id: string, lastUsedAt: number): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface PairingCodeRecord {
  id: string;
  /** Lowercase hex SHA-256 of the code. */
  codeHash: string;
  expiresAt: number;
  failedAttempts: number;
}

export interface PairingCodeRepository {
  list(): Promise<PairingCodeRecord[]>;
  insert(code: PairingCodeRecord): Promise<void>;
  setFailedAttempts(id: string, failedAttempts: number): Promise<void>;
  /** `true` for exactly one caller per code, also across processes. */
  delete(id: string): Promise<boolean>;
}

/**
 * Everything persisted. Never holds a plaintext secret or any CLI credential.
 * The database may be opened by a second, short-lived process while the
 * server runs (the `pair` command), so every read sees committed writes of
 * other connections and a busy database is waited for, not failed on.
 */
export interface Storage {
  readonly turns: TurnRepository;
  readonly presets: PresetRepository;
  readonly settings: SettingsRepository;
  readonly devices: DeviceRepository;
  readonly pairingCodes: PairingCodeRepository;
  close(): Promise<void>;
}
