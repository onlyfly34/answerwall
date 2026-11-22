import type {
  ExecutedProviderKind,
  ModelInfo,
  ProviderDetection,
  ProviderErrorCode,
  ProviderInstance,
  ProviderStatus,
  StreamingMode,
  ToolAccess,
  Usage,
} from '../protocol/index.ts';

export type ProviderEvent =
  /**
   * `streaming`: what this run turned out to be, when the adapter knows.
   * Otherwise the runner uses the instance's cached detection, then `unknown`.
   */
  | { type: 'start'; streaming?: StreamingMode }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  /** Something the user should see that is not part of the answer, e.g. a denied tool call. */
  | { type: 'notice'; message: string }
  | { type: 'done'; usage?: Usage; elapsedMs: number }
  | { type: 'error'; code: ProviderErrorCode; message: string };

export interface RunRequest {
  prompt: string;
  /**
   * The runner has already resolved it: the target's model, else the
   * instance's `defaultModel` (the resolved value is what the snapshot
   * records). Still absent: the adapter passes no model flag and the
   * provider picks its own default.
   */
  model?: string;
  effort?: string;
  /**
   * The configured slot timeout. The runner enforces it by aborting `signal`;
   * it is passed along only for providers that must be told a time limit of
   * their own.
   */
  timeoutMs: number;
  /**
   * Aborted by the runner on cancel, timeout and shutdown. The adapter must
   * then stop the provider (kill the whole process tree, or abort the HTTP
   * request) and end the iteration promptly. The runner decides whether the
   * slot ends as cancelled or timed out; events yielded after the abort are
   * ignored.
   */
  signal: AbortSignal;
  /** Fresh empty directory owned by the runner; the child's cwd. The runner deletes it afterwards. */
  workDir: string;
}

/**
 * One provider kind. Stateless: everything instance-specific comes from the
 * `instance` argument. Implemented once per file under `providers/`.
 */
export interface ProviderAdapter {
  readonly kind: ExecutedProviderKind;
  readonly toolAccess: ToolAccess;
  /** The exact official login command shown to the user; absent for HTTP providers. */
  readonly loginCommand?: string;

  /**
   * Checks installation and login through the provider's own status command.
   * May spawn a process, so it runs only at server start and on Refresh.
   * Must not return account identifiers or absolute paths.
   */
  detect(instance: ProviderInstance): Promise<ProviderDetection>;

  /** Present when the provider can list its models. */
  listModels?(instance: ProviderInstance): Promise<ModelInfo[]>;

  /**
   * Answers one prompt. Yields `start` first, then any number of `delta`,
   * `reasoning` and `notice`, and ends with exactly one `done` or `error`.
   * Never throws; failures are `error` events.
   */
  run(instance: ProviderInstance, request: RunRequest): AsyncIterable<ProviderEvent>;
}

export interface ProviderRegistry {
  /**
   * The adapter of a kind the server runs itself. `web` has none: its slots
   * are run by the client that created the ask.
   */
  adapter(kind: ExecutedProviderKind): ProviderAdapter;
  /**
   * Status of every configured instance from the current settings and the
   * detection cache. Never spawns anything. A web instance is never
   * detected: its `detection` stays `null`.
   */
  list(): ProviderStatus[];
  /**
   * Re-runs detect() and listModels() for one instance, or for every enabled
   * instance, and returns the updated list. Web instances are skipped.
   * @throws AppError `unknown_provider`
   */
  refresh(id?: string): Promise<ProviderStatus[]>;
  /** Kills any detection process still running. */
  shutdown(): Promise<void>;
}
