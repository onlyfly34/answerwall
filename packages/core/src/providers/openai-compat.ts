import { createParser } from 'eventsource-parser';
import { apiKeyOriginEnvName, SECRET_KEYS, secretEnvName } from '../contracts/index.ts';
import type {
  Clock,
  Logger,
  ProviderAdapter,
  ProviderEvent,
  SecretStore,
} from '../contracts/index.ts';
import type {
  ModelInfo,
  ProviderDetection,
  ProviderErrorCode,
  ProviderInstance,
  Usage,
} from '../protocol/index.ts';
import { classifyFailureText, sanitizeDiagnostic } from './failure.ts';
import type { Failure } from './failure.ts';

export interface OpenAiCompatDeps {
  /** Holds each endpoint's API key. */
  secrets: SecretStore;
  clock: Clock;
  logger: Logger;
  /** Aborted on shutdown; stops detection requests. */
  shutdownSignal: AbortSignal;
  /** The environment that supplies the secret overlay; see {@link apiKeyOriginEnvName}. */
  env?: NodeJS.ProcessEnv;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  detectTimeoutMs?: number;
}

const DETECT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_LENGTH = 64 * 1024;
const MAX_MODELS_BODY_LENGTH = 8 * 1024 * 1024;
/** A server that ignores `stream` answers with one JSON document of at most this size. */
const MAX_COMPLETION_BODY_LENGTH = 16 * 1024 * 1024;
const MAX_MODELS = 500;

/**
 * The API root of an endpoint: the given URL without query, fragment,
 * credentials, trailing slashes or a pasted route name, and with `/v1`
 * appended unless the path already names an API version.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  let pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|completions|models)$/, '')
    .replace(/\/+$/, '');
  if (!/(^|\/)v\d+[a-z0-9]*(\/|$)/i.test(pathname)) pathname += '/v1';
  return url.origin + pathname;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** Content is a string, or a list of parts of which the text ones count. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part: unknown) => (isRecord(part) ? (text(part.text) ?? '') : (text(part) ?? '')))
    .join('');
}

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  const input = count(value.prompt_tokens) ?? count(value.input_tokens);
  const output = count(value.completion_tokens) ?? count(value.output_tokens);
  const details = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : value.output_tokens_details;
  const reasoning = isRecord(details) ? count(details.reasoning_tokens) : undefined;
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** What an error body says: `{ error: { message, code, type } }` and its common variants. */
function errorDetail(body: unknown): string {
  if (!isRecord(body)) return '';
  const error = body.error;
  if (typeof error === 'string') return error;
  const source = isRecord(error) ? error : body;
  return [source.code, source.type, source.message, source.detail]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const BODY_CODES: readonly ProviderErrorCode[] = ['model_not_found', 'prompt_too_long', 'quota'];

function codeForStatus(status: number, said: string): ProviderErrorCode {
  const guessed = classifyFailureText(said);
  switch (status) {
    case 401:
    case 403:
      return 'not_logged_in';
    case 402:
      return 'quota';
    case 404:
      return /model/i.test(said) ? 'model_not_found' : 'unsupported';
    case 413:
      return 'prompt_too_long';
    case 429:
      return guessed === 'quota' ? 'quota' : 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'network';
    default:
      return guessed !== undefined && BODY_CODES.includes(guessed) ? guessed : 'unknown';
  }
}

/** Maps an HTTP error. The body may be JSON, HTML or empty; the API key never appears. */
export function failureFromHttp(status: number, body: string, apiKey?: string): Failure {
  const parsed = parseJson(body);
  // A body that is not JSON is a proxy's error page; it explains nothing to the user.
  let said = parsed === undefined ? '' : errorDetail(parsed);
  if (apiKey) said = said.replaceAll(apiKey, '<redacted>');
  const detail = sanitizeDiagnostic(said);
  return {
    code: codeForStatus(status, said),
    message: detail === '' ? `The endpoint answered HTTP ${status}.` : `HTTP ${status}: ${detail}`,
  };
}

/** The server refused the request because of the usage option, not because of the prompt. */
function rejectsUsageOption(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /stream_options|include_usage/i.test(body);
}

async function readBounded(response: Response, maxLength: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (body.length < maxLength) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return body.slice(0, maxLength);
}

function networkFailure(cause: unknown): Failure {
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  const code =
    isRecord(inner) || inner instanceof Error
      ? text((inner as { code?: unknown }).code)
      : undefined;
  return {
    code: 'network',
    message: `The endpoint could not be reached${code ? ` (${code.replace(/[^\w-]/g, '')})` : ''}.`,
  };
}

const NON_CHAT_ID =
  /embed|whisper|tts|dall-e|moderation|rerank|transcri|speech|image|sora|realtime|audio/i;
const NON_CHAT_TYPE = /embed|image|audio|rerank|moderation|speech|tts|stt/i;

function isChatModel(entry: Record<string, unknown>, id: string): boolean {
  const kind = text(entry.type) ?? text(entry.mode) ?? text(entry.task) ?? '';
  if (NON_CHAT_TYPE.test(kind)) return false;
  if (isRecord(entry.capabilities) && entry.capabilities.completion_chat === false) return false;
  return !NON_CHAT_ID.test(id);
}

/**
 * Reads a model listing: `{ data: [...] }`, `{ models: [...] }` or a bare
 * array, of objects or plain ids. Models that are obviously not chat models
 * (embeddings, speech, images) are left out.
 */
export function parseModelsResponse(body: unknown): ModelInfo[] {
  const list = Array.isArray(body)
    ? body
    : isRecord(body)
      ? [body.data, body.models].find(Array.isArray)
      : undefined;
  if (!Array.isArray(list)) return [];
  const models = new Map<string, ModelInfo>();
  for (const entry of list as unknown[]) {
    const record = isRecord(entry) ? entry : {};
    const id = (text(entry) ?? text(record.id) ?? text(record.name) ?? text(record.model))?.trim();
    if (!id || id.length > 200 || models.has(id) || !isChatModel(record, id)) continue;
    models.set(id, { id });
    if (models.size === MAX_MODELS) break;
  }
  return [...models.values()];
}

type ModelsResult =
  | { status: 'ok'; models: ModelInfo[] }
  | { status: 'http'; code: number }
  | { status: 'unreachable'; failure: Failure }
  | { status: 'timeout' | 'aborted' };

interface StreamState {
  usage?: Usage;
  failure?: Failure;
  finished: boolean;
  sawCompletion: boolean;
}

/** One `data:` payload of the stream, or a whole non-streamed completion. */
function completionEvents(payload: unknown, state: StreamState, apiKey?: string): ProviderEvent[] {
  if (!isRecord(payload)) return [];
  if (payload.error !== undefined && payload.error !== null) {
    let said = errorDetail(payload);
    if (apiKey) said = said.replaceAll(apiKey, '<redacted>');
    state.failure = {
      code: classifyFailureText(said) ?? 'unknown',
      message: sanitizeDiagnostic(said) || 'The endpoint reported an error.',
    };
    return [];
  }
  const usage = usageOf(payload.usage);
  if (usage) state.usage = usage;
  const choice: unknown = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice)) return [];
  state.sawCompletion = true;
  if (typeof choice.finish_reason === 'string') state.finished = true;
  const part = isRecord(choice.delta)
    ? choice.delta
    : isRecord(choice.message)
      ? choice.message
      : {};
  const events: ProviderEvent[] = [];
  const reasoning = contentText(part.reasoning_content) || contentText(part.reasoning);
  if (reasoning !== '') events.push({ type: 'reasoning', text: reasoning });
  const answer = contentText(part.content);
  if (answer !== '') events.push({ type: 'delta', text: answer });
  return events;
}

/** Whether both addresses name the same scheme, host and port. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const origin = new URL(a).origin;
    return origin !== 'null' && origin === new URL(b.trim()).origin;
  } catch {
    return false;
  }
}

export function createOpenAiCompatAdapter(deps: OpenAiCompatDeps): ProviderAdapter {
  const { clock, secrets } = deps;
  const request: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init);

  const env = deps.env ?? {};

  /**
   * The key to send to `root`, if any. `withheld`: there is a key, but it
   * comes from the environment and `root` is not the origin pinned for it.
   */
  const keyFor = async (
    instance: ProviderInstance,
    root: string | undefined,
  ): Promise<{ apiKey?: string; withheld: boolean }> => {
    const key = SECRET_KEYS.providerApiKey(instance.id);
    const apiKey = (await secrets.get(key)) || undefined;
    if (apiKey === undefined) return { withheld: false };
    if (!env[secretEnvName(key)]) return { apiKey, withheld: false };
    const pin = env[apiKeyOriginEnvName(instance.id)];
    return root !== undefined && pin !== undefined && sameOrigin(root, pin)
      ? { apiKey, withheld: false }
      : { withheld: true };
  };
  const apiKeyOf = async (instance: ProviderInstance): Promise<string | undefined> =>
    (await keyFor(instance, rootOf(instance))).apiKey;

  const rootOf = (instance: ProviderInstance): string | undefined => {
    if (instance.kind !== 'openai-compat') return undefined;
    try {
      return normalizeBaseUrl(instance.baseUrl);
    } catch {
      return undefined;
    }
  };

  const headers = (apiKey: string | undefined, extra: Record<string, string>) => ({
    ...extra,
    ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
  });

  async function fetchModels(instance: ProviderInstance): Promise<ModelsResult> {
    const root = rootOf(instance);
    if (root === undefined) {
      return {
        status: 'unreachable',
        failure: { code: 'unsupported', message: 'The base URL is not valid.' },
      };
    }
    if (deps.shutdownSignal.aborted) return { status: 'aborted' };
    const stop = new AbortController();
    let timedOut = false;
    const cancelTimeout = clock.schedule(deps.detectTimeoutMs ?? DETECT_TIMEOUT_MS, () => {
      timedOut = true;
      stop.abort();
    });
    const onShutdown = (): void => stop.abort();
    deps.shutdownSignal.addEventListener('abort', onShutdown, { once: true });
    try {
      const apiKey = await apiKeyOf(instance);
      const response = await request(`${root}/models`, {
        headers: headers(apiKey, { Accept: 'application/json' }),
        signal: stop.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: 'http', code: response.status };
      }
      const body = parseJson(await readBounded(response, MAX_MODELS_BODY_LENGTH));
      return { status: 'ok', models: parseModelsResponse(body) };
    } catch (cause) {
      if (timedOut) return { status: 'timeout' };
      if (stop.signal.aborted) return { status: 'aborted' };
      return { status: 'unreachable', failure: networkFailure(cause) };
    } finally {
      cancelTimeout();
      deps.shutdownSignal.removeEventListener('abort', onShutdown);
    }
  }

  return {
    kind: 'openai-compat',
    toolAccess: 'none',

    async detect(instance): Promise<ProviderDetection> {
      const { apiKey, withheld } = await keyFor(instance, rootOf(instance));
      const hasKey = apiKey !== undefined;
      const base = { billing: hasKey ? 'api-key' : 'unknown', streaming: 'token' } as const;
      if (withheld) {
        return {
          installed: true,
          loggedIn: 'no',
          ...base,
          hint: `The API key from the environment is not sent: set ${apiKeyOriginEnvName(instance.id)} to this endpoint's origin (scheme, host and port) to allow it.`,
        };
      }
      const result = await fetchModels(instance);
      switch (result.status) {
        case 'ok':
          return { installed: true, loggedIn: 'yes', ...base };
        case 'http':
          return result.code === 401 || result.code === 403
            ? {
                installed: true,
                loggedIn: 'no',
                ...base,
                hint: hasKey
                  ? `The endpoint rejected the API key (HTTP ${result.code}).`
                  : `The endpoint requires an API key (HTTP ${result.code}).`,
              }
            : {
                installed: true,
                loggedIn: 'unknown',
                ...base,
                hint: `The endpoint has no usable model list (HTTP ${result.code}); add model names by hand.`,
              };
        case 'unreachable':
          return { installed: false, loggedIn: 'unknown', ...base, hint: result.failure.message };
        case 'timeout':
          return {
            installed: false,
            loggedIn: 'unknown',
            ...base,
            hint: 'The endpoint did not answer in time.',
          };
        case 'aborted':
          return {
            installed: false,
            loggedIn: 'unknown',
            ...base,
            hint: 'Detection was interrupted.',
          };
      }
    },

    async listModels(instance): Promise<ModelInfo[]> {
      const result = await fetchModels(instance);
      return result.status === 'ok' ? result.models : [];
    },

    async *run(instance, run) {
      const startedAt = clock.now();
      yield { type: 'start', streaming: 'token' };
      const fail = (failure: Failure): ProviderEvent => ({ type: 'error', ...failure });
      if (run.signal.aborted) {
        yield fail({ code: 'cancelled', message: 'Cancelled before the request was sent.' });
        return;
      }
      const root = rootOf(instance);
      if (root === undefined) {
        yield fail({ code: 'unsupported', message: 'The base URL is not valid.' });
        return;
      }

      let apiKey: string | undefined;
      let body: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const state: StreamState = { finished: false, sawCompletion: false };
      try {
        const key = await keyFor(instance, root);
        if (key.withheld) {
          yield fail({
            code: 'not_logged_in',
            message: `The API key from the environment is not sent to this address: ${apiKeyOriginEnvName(instance.id)} does not name its origin.`,
          });
          return;
        }
        apiKey = key.apiKey;
        const post = (withUsage: boolean): Promise<Response> =>
          request(`${root}/chat/completions`, {
            method: 'POST',
            headers: headers(apiKey, {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            }),
            body: JSON.stringify({
              ...(run.model === undefined ? {} : { model: run.model }),
              messages: [{ role: 'user', content: run.prompt }],
              stream: true,
              ...(withUsage ? { stream_options: { include_usage: true } } : {}),
              ...(run.effort === undefined ? {} : { reasoning_effort: run.effort }),
            }),
            signal: run.signal,
          });

        let response = await post(true);
        if (!response.ok) {
          const refusal = await readBounded(response, MAX_ERROR_BODY_LENGTH);
          if (!rejectsUsageOption(response.status, refusal)) {
            yield fail(failureFromHttp(response.status, refusal, apiKey));
            return;
          }
          // Not a retry of a failed answer: the server refused the option, so ask without it.
          response = await post(false);
          if (!response.ok) {
            const again = await readBounded(response, MAX_ERROR_BODY_LENGTH);
            yield fail(failureFromHttp(response.status, again, apiKey));
            return;
          }
        }

        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
          // The server ignored `stream` and answered with one whole completion.
          const whole = parseJson(await readBounded(response, MAX_COMPLETION_BODY_LENGTH));
          yield* completionEvents(whole, state, apiKey);
        } else if (response.body) {
          body = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
          const pending: string[] = [];
          const parser = createParser({ onEvent: (event) => pending.push(event.data) });
          const decoder = new TextDecoder();
          let ended = false;
          while (!ended) {
            const { done, value } = await body.read();
            // A stream may end without the blank line that closes its last event: close it here.
            parser.feed(done ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true }));
            for (const data of pending.splice(0)) {
              if (data.trim() === '[DONE]') {
                ended = true;
                state.finished = true;
                break;
              }
              yield* completionEvents(parseJson(data), state, apiKey);
              if (state.failure) {
                ended = true;
                break;
              }
            }
            if (done) break;
          }
        }
      } catch (cause) {
        if (run.signal.aborted) {
          yield fail({ code: 'cancelled', message: 'The request was stopped.' });
        } else {
          deps.logger.debug('openai-compat request failed', { providerId: instance.id });
          yield fail(networkFailure(cause));
        }
        return;
      } finally {
        await body?.cancel().catch(() => undefined);
      }

      if (run.signal.aborted) {
        yield fail({ code: 'cancelled', message: 'The request was stopped.' });
      } else if (state.failure) {
        yield fail(state.failure);
      } else if (!state.sawCompletion && !state.finished) {
        yield fail({ code: 'bad_output', message: 'The endpoint sent no completion data.' });
      } else {
        yield {
          type: 'done',
          elapsedMs: Math.max(0, clock.now() - startedAt),
          ...(state.usage ? { usage: state.usage } : {}),
        };
      }
    },
  };
}
