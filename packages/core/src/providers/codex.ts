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
import { isRecord, parseJsonLine, runCli } from './cli/run-cli.ts';
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
/**
 * `exec --json` prints every agent message and reasoning summary whole, in one
 * `item.completed` line: real runs (0.167.0) showed no `item.updated` and no
 * text deltas, and `exec` has no other output mode that streams them.
 */
const STREAMING: StreamingMode = 'block';

/**
 * The key a run authenticates with when it is set, whatever login is saved:
 * `codex doctor` then reports API key auth while `codex login status` goes on
 * reporting the ChatGPT login (0.167.0). `OPENAI_API_KEY` has no such effect.
 */
const EXEC_KEY_VARIABLE = 'CODEX_API_KEY';

const isBillingVariable = (name: string): boolean =>
  name === EXEC_KEY_VARIABLE || name === 'OPENAI_API_KEY';

/**
 * Features switched off so that the model is left with as few tools as the
 * CLI allows. Checked with `codex features list` and `codex debug prompt-input`
 * (0.167.0): `shell_tool` removes the command tools, `apps` the connector
 * namespaces, `sleep_tool` and `view_image` their tools; `plugins`, `hooks`,
 * `image_generation`, `browser_use` and `computer_use` change nothing the
 * rendered prompt shows and are kept as a precaution; `multi_agent` does not
 * remove the sub-agent tools (the overrides below do) and `unified_exec`
 * cannot be switched off at all.
 */
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
 * Configuration overrides that keep the user's setup and the CLI's agent
 * scaffolding away from the model. Each one was checked with
 * `codex debug prompt-input` (0.167.0); the comment says what it removes.
 */
export const CODEX_ISOLATION_OVERRIDES: readonly string[] = [
  // An AGENTS.md found from the work dir upwards (not the global one).
  'project_doc_max_bytes=0',
  // The skills shipped with the CLI, then the list of every other skill.
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
  // Sandbox and approval instructions, the connector instructions, the
  // work dir / shell / date / time zone block, the collaboration mode block.
  'include_permissions_instructions=false',
  'include_apps_instructions=false',
  'include_environment_context=false',
  'include_collaboration_mode_instructions=false',
  // The tools that ask the user a question; nobody could answer.
  'tools.experimental_request_user_input.enabled=false',
  // Sub-agents: the older tool set, then the newer one and its two prompts.
  'agents.max_depth=0',
  'features.multi_agent_v2.disable_native_tools=true',
  'features.multi_agent_v2.multi_agent_mode_hint_text=""',
  'features.multi_agent_v2.root_agent_usage_hint_text=""',
];

/**
 * What the flags above cannot remove, as observed with
 * `codex debug prompt-input` and real runs (0.167.0). Shown with every
 * detection so the provider page says it. Web search is not mentioned: it
 * follows the instance's switch, which the provider page shows next to this.
 */
const RESIDUAL_HINT =
  "The model cannot run commands or read your files. Still sent: the CLI's own instructions and your global AGENTS.md, if any. Still offered: a script tool that can read the clock and try a file edit, which the read-only sandbox refuses.";

/** The CLI refuses to start when it no longer knows a feature name or an override it is given. */
const UNKNOWN_SWITCH = /unknown feature flag|data did not match any variant|unknown variant/i;
const UNKNOWN_SWITCH_MESSAGE =
  'This version of `codex` does not accept one of the switches this app passes to limit its tools, so it refused to start. Update the app or use a supported CLI version.';

const override = (setting: string): string[] => ['-c', setting];

/**
 * The non-interactive invocation: one prompt read from stdin (`-`), JSON
 * events on stdout, no `config.toml`, no execpolicy rules, no session files,
 * read-only sandbox, no web search unless asked for. `--ignore-user-config`
 * covers `config.toml` only; the overrides remove the rest of the user's
 * setup except the global `AGENTS.md`, which no switch removes
 * (`CODEX_HOME` cannot be moved: the login lives there).
 */
export function buildCodexArgs(selection: {
  workDir: string;
  model?: string;
  effort?: string;
  /** Lets the model use the CLI's hosted web search; every other tool stays off. */
  webSearch?: boolean;
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
      : override(`model_reasoning_effort="${selection.effort}"`)),
    ...override(`web_search="${selection.webSearch === true ? 'live' : 'disabled'}"`),
    ...CODEX_ISOLATION_OVERRIDES.flatMap(override),
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

/**
 * The message of an error. A request the service refused arrives as the
 * service's JSON answer in a string; its own `error.message` is the readable part.
 */
function errorMessage(value: unknown): string | undefined {
  const message = text(value) ?? (isRecord(value) ? text(value.message) : undefined);
  if (message === undefined) return undefined;
  const body = parseJsonLine(message);
  const inner = isRecord(body?.error) ? text(body.error.message) : text(body?.detail);
  return inner ?? message;
}

/** The service's wording for a reasoning effort it does not accept. */
const REFUSED_EFFORT = /reasoning\.effort|ReasoningEffort/;

function failureOf(message: string): NonNullable<ParserOutcome['failure']> {
  return REFUSED_EFFORT.test(message) ? { code: 'unsupported', message } : { message };
}

const SEARCH_NOTICE = 'The model searched the web.';
const toolNotice = (kind: string): string =>
  `The model used a tool (${kind}). This CLI cannot switch its tools off completely; they run in a read-only sandbox.`;

/**
 * Maps `codex exec --json` lines. The real CLI prints whole items
 * (`item.completed` only); an item's text is still emitted as it grows, so a
 * version that starts sending `item.updated` works too. A turn may hold
 * several agent messages (a remark before the answer); they are joined.
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
        // None of these was seen with search off; `web_search` is what a search prints.
        if (noticed.has(kind)) return [];
        noticed.add(kind);
        return [
          { type: 'notice', message: kind === 'web_search' ? SEARCH_NOTICE : toolNotice(kind) },
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
      // It is also what the CLI repeats while it retries ("Reconnecting... 2/5").
      const failure = turnFailure ?? (completed ? undefined : lastError);
      return {
        completed,
        ...(usage ? { usage } : {}),
        ...(failure === undefined ? {} : { failure: failureOf(failure) }),
      };
    },
  };
}

/**
 * Reads `codex login status`: one sentence on stderr, nothing on stdout, exit
 * code 0 when logged in ("Logged in using ChatGPT") and 1 when not ("Not
 * logged in"). Only the kind of login is taken from it; the sentence for an
 * API key login also carries part of the key and is never kept.
 */
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
      // `login status` reports the saved login; a run uses this key when it is passed on.
      const keyed =
        cliSwitches(instance).useEnvApiKey &&
        hasVariable(context.env, context.platform, EXEC_KEY_VARIABLE);
      // Without a saved login a run can still authenticate with the key.
      const login: LoginState = keyed && loggedIn === 'no' ? 'unknown' : loggedIn;
      return {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        loggedIn: login,
        billing: keyed ? 'api-key' : report.billing,
        streaming: STREAMING,
        ...joinHints(
          login === 'no' ? `Not logged in. Run \`${LOGIN_COMMAND}\` in a terminal.` : undefined,
          loggedIn === 'unknown' ? 'The login state could not be determined.' : undefined,
          keyed
            ? `Passed to the CLI from the environment: ${EXEC_KEY_VARIABLE}. Runs are billed to this key, whatever login \`codex login status\` reports.`
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
          args: buildCodexArgs({
            workDir: request.workDir,
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            webSearch: cliSwitches(instance).webSearch,
          }),
          env: childEnvFor(context, instance),
          stdin: request.prompt,
          parser: createCodexParser(),
          streaming: STREAMING,
          knownFailure: (said) =>
            UNKNOWN_SWITCH.test(said)
              ? { code: 'unsupported', message: UNKNOWN_SWITCH_MESSAGE }
              : undefined,
        },
        request,
        context,
      );
    },
  };
}
