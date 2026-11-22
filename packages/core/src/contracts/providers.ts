import type {
  ModelInfo,
  ProviderDetection,
  ProviderErrorCode,
  ProviderInstance,
  ProviderKind,
  ProviderStatus,
  ToolAccess,
  Usage,
} from '../protocol/index.ts';

export type ProviderEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  /** Something the user should see that is not part of the answer, e.g. a denied tool call. */
  | { type: 'notice'; message: string }
  | { type: 'done'; usage?: Usage; elapsedMs: number }
  | { type: 'error'; code: ProviderErrorCode; message: string };

export interface RunRequest {
  prompt: string;
  model?: string;
  effort?: string;
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
  readonly kind: ProviderKind;
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
  /** The adapter of a kind; every `ProviderKind` has one. */
  adapter(kind: ProviderKind): ProviderAdapter;
  /**
   * Status of every configured instance from the current settings and the
   * detection cache. Never spawns anything.
   */
  list(): ProviderStatus[];
  /**
   * Re-runs detect() and listModels() for one instance, or for every enabled
   * instance, and returns the updated list.
   * @throws AppError `unknown_provider`
   */
  refresh(id?: string): Promise<ProviderStatus[]>;
  /** Kills any detection process still running. */
  shutdown(): Promise<void>;
}
