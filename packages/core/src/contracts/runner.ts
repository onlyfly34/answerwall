import type {
  AskRequest,
  AskResponse,
  AskSnapshot,
  StreamEvent,
  WebResultRequest,
  WebResultResponse,
} from '../protocol/index.ts';
import type { AuthContext } from './auth.ts';

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
   *
   * `owner` is who created the ask. Only the owner may submit the results of
   * its web slots, so an ask with a web target needs one, needs
   * `request.runsWebSlots`, and needs web cells and the reading of answers
   * switched on.
   * @throws AppError `too_many_targets` | `prompt_too_long` | `too_many_asks` |
   *   `queue_full` | `unknown_provider` | `provider_disabled` (also: web
   *   cells or the reading of answers are switched off) | `web_client_required` |
   *   `not_found` (unknown conversationId) | `conflict` (the server is
   *   shutting down) | `bad_request` (duplicate `slotId`, for callers that
   *   skip the schema)
   */
  submit(request: AskRequest, owner?: AuthContext): Promise<AskResponse>;

  /**
   * The one result of a running web slot, from the owner of its ask. The
   * slot gets its text (cut at the per-slot output limit, and flagged) and
   * its terminal event like any other slot.
   *
   * Sending the same result again answers the same way, so a client may
   * retry a request whose answer it lost. Anything else about a slot that is
   * no longer running is a `conflict`.
   * @throws AppError `not_found` (ask or slot) | `bad_request` (not a web
   *   slot) | `forbidden` (not the owner; or an answer while reading answers
   *   is switched off) | `conflict` (queued, already terminal, or a different
   *   result than the one accepted)
   */
  submitWebResult(
    askId: string,
    slotId: string,
    result: WebResultRequest,
    caller: AuthContext,
  ): Promise<WebResultResponse>;

  /**
   * Current status and accumulated text per slot; falls back to storage for
   * asks that are no longer in memory.
   * @throws AppError `not_found`
   */
  snapshot(askId: string): Promise<AskSnapshot>;

  /**
   * The ask's events after `options.after`, then live events. Any number of
   * subscribers may exist at once.
   *
   * The iteration always ends with a terminal event (`isTerminalStreamEvent`)
   * unless the subscriber aborts first:
   * - normally `ask_done`;
   * - for an ask that is already done, when nothing remains to replay
   *   (`after` is at or beyond its last `seq`) or its event log is gone (it
   *   was loaded from storage): a single `snapshot` event whose snapshot has
   *   status `done`.
   *
   * For a running ask whose resume point is not available (older than the
   * retained log, or beyond the last `seq`), the first event is a `snapshot`
   * and live events follow.
   * @throws AppError `not_found` (before anything is yielded)
   */
  subscribe(askId: string, options: SubscribeOptions): Promise<AsyncIterable<StreamEvent>>;

  /**
   * Cancels one slot, or every unfinished slot. Returns the slot ids that
   * were still queued or running.
   * @throws AppError `not_found`
   */
  cancel(askId: string, slotId?: string): Promise<string[]>;

  /**
   * Drops a finished ask from memory, ending its subscriptions; a no-op for
   * an ask that is unknown or still running. Called after the ask was deleted
   * from history, so it stops being readable through the ask routes.
   */
  forget(askId: string): void;

  /** Cancels everything, waits for every child process to be gone, flushes to storage. */
  shutdown(): Promise<void>;
}
