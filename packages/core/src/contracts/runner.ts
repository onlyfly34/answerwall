import type { AskRequest, AskResponse, AskSnapshot, StreamEvent } from '../protocol/index.ts';

export interface SubscribeOptions {
  /** Replay events with `seq` greater than this. Omitted: from the beginning. */
  after?: number;
  /** Aborting ends the iteration; it never cancels the ask. */
  signal: AbortSignal;
}

/** Owns every ask from submission to its final flush to storage. */
export interface AskManager {
  /** Fails slots left unfinished by a previous process with `SERVER_RESTARTED_ERROR`. */
  start(): Promise<void>;

  /**
   * Validates against the configured limits, persists the ask, queues every
   * slot and returns immediately.
   * @throws AppError `too_many_targets` | `prompt_too_long` | `too_many_asks` |
   *   `queue_full` | `unknown_provider` | `provider_disabled` | `not_found`
   *   (unknown conversationId)
   */
  submit(request: AskRequest): Promise<AskResponse>;

  /**
   * Current status and accumulated text per slot; falls back to storage for
   * asks that are no longer in memory.
   * @throws AppError `not_found`
   */
  snapshot(askId: string): Promise<AskSnapshot>;

  /**
   * The ask's events after `options.after`, then live events until `ask_done`.
   * When the resume point is no longer available the first event is a
   * `snapshot`. Any number of subscribers may exist at once.
   * @throws AppError `not_found` (before anything is yielded)
   */
  subscribe(askId: string, options: SubscribeOptions): Promise<AsyncIterable<StreamEvent>>;

  /**
   * Cancels one slot, or every unfinished slot. Returns the slot ids that
   * were still queued or running.
   * @throws AppError `not_found`
   */
  cancel(askId: string, slotId?: string): Promise<string[]>;

  /** Cancels everything, waits for every child process to be gone, flushes to storage. */
  shutdown(): Promise<void>;
}
