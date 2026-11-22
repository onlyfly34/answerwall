import type { ProviderAdapter } from '../contracts/index.ts';
import type {
  BillingSource,
  LoginState,
  ModelInfo,
  ProviderDetection,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { isRecord, runCli } from './cli/run-cli.ts';
import type { CliContext, ContentEvent, ParserOutcome, StreamParser } from './cli/run-cli.ts';
import { hasVariable } from './cli/child-env.ts';
import {
  billingReport,
  childEnvFor,
  cliSwitches,
  isEffortArgument,
  joinHints,
  printed,
  probeVersion,
  rejectedSelection,
  text,
  tokenCount,
} from './cli/support.ts';
import { sanitizeDiagnostic } from './failure.ts';

const EXECUTABLE = 'codex';
const LOGIN_COMMAND = 'codex login';
/** The documented `exec --json` events carry whole items, not text deltas. */
const STREAMING: StreamingMode = 'block';

/** Documented as the key `codex exec` uses for a single run. */
const EXEC_KEY_VARIABLE = 'CODEX_API_KEY';

const isBillingVariable = (name: string): boolean =>
  name === EXEC_KEY_VARIABLE || name === 'OPENAI_API_KEY';

/** Features switched off so that the model is left with as few tools as the CLI allows. */
export const CODEX_DISABLED_FEATURES: readonly string[] = [
  'shell_tool',
  'unified_exec',
  'apps',
  'plugins',
  'hooks',
  'multi_agent',
  'image_generation',
  'browser_use',
  'computer_use',
  'sleep_tool',
  'view_image',
];

/**
 * What the flags above cannot remove, as observed with
 * `codex debug prompt-input` (0.167.0). Shown with every detection so the
 * provider page says it.
 */
const RESIDUAL_HINT =
  'This CLI still loads your global AGENTS.md and skills, and with some model families the model is still offered built-in tools, including sub-agents; no switch removes them.';

/** The CLI refuses to start when it no longer knows a feature name it is told to disable. */
const UNKNOWN_FEATURE = /unknown feature flag/i;
const UNKNOWN_FEATURE_MESSAGE =
  'This version of `codex` does not know one of the feature switches this app passes to limit its tools, so it refused to start. Update the app or use a supported CLI version.';

/**
 * The non-interactive invocation: one prompt read from stdin (`-`), JSON
 * events on stdout, no `config.toml`, no execpolicy rules, no session files,
 * read-only sandbox. `--ignore-user-config` covers `config.toml` only: the
 * user's global `AGENTS.md` and skills still reach the model, and no tested
 * switch removes them (`CODEX_HOME` cannot be moved: the login lives there).
 */
export function buildCodexArgs(selection: {
  workDir: string;
  model?: string;
  effort?: string;
}): string[] {
  return [
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '-s',
    'read-only',
    '-C',
    selection.workDir,
    ...(selection.model === undefined ? [] : ['-m', selection.model]),
    ...(selection.effort === undefined
      ? []
      : ['-c', `model_reasoning_effort="${selection.effort}"`]),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-',
  ];
}

export const CODEX_VERSION_ARGS = ['--version'];
export const CODEX_STATUS_ARGS = ['login', 'status'];
export const CODEX_MODELS_ARGS = ['debug', 'models'];

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  const reasoning = tokenCount(value.reasoning_output_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

const errorMessage = (value: unknown): string | undefined =>
  text(value) ?? (isRecord(value) ? text(value.message) : undefined);

/**
 * Maps `codex exec --json` lines. An item's text is emitted as it grows, so
 * both whole items (`item.completed` only) and incremental updates work.
 */
export function createCodexParser(): StreamParser {
  const sent = new Map<string, number>();
  const noticed = new Set<string>();
  let anonymousItems = 0;
  let answerItem: string | undefined;
  let completed = false;
  let usage: Usage | undefined;
  let turnFailure: string | undefined;
  let lastError: string | undefined;

  const growth = (key: string, full: string): string => {
    const already = sent.get(key) ?? 0;
    if (full.length <= already) return '';
    sent.set(key, full.length);
    return full.slice(already);
  };

  const item = (value: unknown): ContentEvent[] => {
    if (!isRecord(value)) return [];
    const kind = text(value.type) ?? text(value.item_type) ?? '';
    const key = text(value.id) ?? `#${anonymousItems++}`;
    switch (kind) {
      case 'agent_message':
      case 'assistant_message': {
        const chunk = growth(key, text(value.text) ?? '');
        if (chunk === '') return [];
        const separator = answerItem !== undefined && answerItem !== key ? '\n\n' : '';
        answerItem = key;
        return [{ type: 'delta', text: separator + chunk }];
      }
      case 'reasoning': {
        const chunk = growth(key, text(value.text) ?? '');
        return chunk === '' ? [] : [{ type: 'reasoning', text: `${chunk}\n` }];
      }
      case 'error': {
        const message = sanitizeDiagnostic(errorMessage(value.message) ?? '');
        if (message === '' || noticed.has(`error:${message}`)) return [];
        noticed.add(`error:${message}`);
        return [{ type: 'notice', message }];
      }
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search':
      case 'collab_tool_call': {
        if (noticed.has(kind)) return [];
        noticed.add(kind);
        return [
          {
            type: 'notice',
            message: `The model used a tool (${kind}). This CLI cannot switch its tools off completely; they run in a read-only sandbox.`,
          },
        ];
      }
      default:
        return [];
    }
  };

  return {
    event(value) {
      switch (value.type) {
        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          return item(value.item);
        case 'turn.completed':
          completed = true;
          usage = usageOf(value.usage) ?? usage;
          return [];
        case 'turn.failed':
          turnFailure = errorMessage(value.error) ?? 'The turn failed.';
          return [];
        case 'error':
          lastError = errorMessage(value.message) ?? errorMessage(value.error) ?? lastError;
          return [];
        default:
          return [];
      }
    },
    outcome(): ParserOutcome {
      // A top-level `error` may be a reconnection notice; it is fatal only when the turn never completed.
      const failure = turnFailure ?? (completed ? undefined : lastError);
      return {
        completed,
        ...(usage ? { usage } : {}),
        ...(failure === undefined ? {} : { failure: { message: failure } }),
      };
    },
  };
}

/** Reads `codex login status`, which prints one sentence (on stderr). */
export function parseCodexLoginStatus(
  output: string,
  exitCode: number | null,
): { loggedIn: LoginState; billing: BillingSource } {
  if (/not logged in/i.test(output) || (exitCode !== null && exitCode !== 0)) {
    return { loggedIn: 'no', billing: 'unknown' };
  }
  if (!/logged in/i.test(output)) return { loggedIn: 'unknown', billing: 'unknown' };
  const billing: BillingSource = /chatgpt/i.test(output)
    ? 'subscription'
    : /api key/i.test(output)
      ? 'api-key'
      : 'unknown';
  return { loggedIn: 'yes', billing };
}

/** Reads the `codex debug models` catalogue, keeping the models meant to be listed. */
export function parseCodexModels(stdout: string): ModelInfo[] {
  let catalogue: unknown;
  try {
    catalogue = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entries = isRecord(catalogue) && Array.isArray(catalogue.models) ? catalogue.models : [];
  const models: ModelInfo[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.visibility !== 'list') continue;
    const id = text(entry.slug)?.trim();
    if (!id || id.length > 200) continue;
    const label = text(entry.display_name)?.slice(0, 200);
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels
      : [];
    const efforts = levels
      .map((level) => (isRecord(level) ? text(level.effort) : text(level)))
      .filter((effort): effort is string => effort !== undefined && isEffortArgument(effort))
      .slice(0, 16);
    models.push({
      id,
      ...(label ? { label } : {}),
      ...(efforts.length === 0 ? {} : { efforts }),
    });
  }
  return models;
}

export function createCodexAdapter(context: CliContext): ProviderAdapter {
  return {
    kind: 'codex',
    toolAccess: 'read-only',
    loginCommand: LOGIN_COMMAND,

    async detect(instance): Promise<ProviderDetection> {
      const env = childEnvFor(context, instance);
      const probe = await probeVersion(context, EXECUTABLE, CODEX_VERSION_ARGS, env, STREAMING);
      if (!probe.available) return probe.detection;
      const status = await captureCli(EXECUTABLE, CODEX_STATUS_ARGS, env, context);
      const { loggedIn, billing: fromLogin } =
        status.outcome === 'exited'
          ? parseCodexLoginStatus(printed(status), status.code)
          : { loggedIn: 'unknown' as const, billing: 'unknown' as const };
      const report = billingReport(context, instance, isBillingVariable, fromLogin);
      // `login status` reports the saved login, while `exec` is documented to take this key for the run.
      const overridden =
        fromLogin === 'subscription' &&
        cliSwitches(instance).useEnvApiKey &&
        hasVariable(context.env, context.platform, EXEC_KEY_VARIABLE);
      return {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        loggedIn,
        billing: overridden ? 'unknown' : report.billing,
        streaming: STREAMING,
        ...joinHints(
          loggedIn === 'no' ? `Not logged in. Run \`${LOGIN_COMMAND}\` in a terminal.` : undefined,
          loggedIn === 'unknown' ? 'The login state could not be determined.' : undefined,
          overridden
            ? `Passed to the CLI from the environment: ${EXEC_KEY_VARIABLE}. The CLI documents that a run uses this key, while its status command reports the ChatGPT login, so which one is billed is not known here.`
            : report.hint,
          RESIDUAL_HINT,
        ),
      };
    },

    async listModels(instance): Promise<ModelInfo[]> {
      const result = await captureCli(
        EXECUTABLE,
        CODEX_MODELS_ARGS,
        childEnvFor(context, instance),
        context,
      );
      return result.outcome === 'exited' && result.code === 0
        ? parseCodexModels(result.stdout)
        : [];
    },

    async *run(instance, request) {
      const rejected = rejectedSelection(request, STREAMING);
      if (rejected) {
        yield* rejected;
        return;
      }
      yield* runCli(
        {
          executable: EXECUTABLE,
          args: buildCodexArgs(request),
          env: childEnvFor(context, instance),
          stdin: request.prompt,
          parser: createCodexParser(),
          streaming: STREAMING,
          knownFailure: (said) =>
            UNKNOWN_FEATURE.test(said)
              ? { code: 'unsupported', message: UNKNOWN_FEATURE_MESSAGE }
              : undefined,
        },
        request,
        context,
      );
    },
  };
}
