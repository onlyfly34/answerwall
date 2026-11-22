import { BRAND } from '../brand.ts';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../contracts/index.ts';
import type {
  LoginState,
  ModelInfo,
  ProviderDetection,
  ProviderErrorCode,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import { LOGIN_COMMANDS } from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { isRecord, runCli } from './cli/run-cli.ts';
import type { CliContext, ContentEvent, ParserOutcome, StreamParser } from './cli/run-cli.ts';
import {
  billingReport,
  childEnvFor,
  isEffortArgument,
  isModelArgument,
  joinHints,
  probeVersion,
  text,
  tokenCount,
} from './cli/support.ts';
import { sanitizeDiagnostic } from './failure.ts';
import type { Failure } from './failure.ts';

const EXECUTABLE = 'opencode';
const LOGIN_COMMAND = LOGIN_COMMANDS.opencode;
/** `run --format json` prints a text part when it is complete, never its deltas. */
const STREAMING: StreamingMode = 'block';
/** The first major version whose `run` has the private server and the rule format used here. */
const SUPPORTED_MAJOR = 2;

/**
 * The agent every question is answered with. It exists only in the project
 * file of the per-request work dir, so a run that did not read that file
 * fails with "Agent not found" instead of answering with the default agent
 * and all of its tools.
 */
export const OPENCODE_AGENT = BRAND.slug;
/** The CLI reads a project configuration of this name from its working directory. */
export const OPENCODE_PROJECT_FILE = 'opencode.json';

/**
 * The documented switch that keeps `CLAUDE.md` files (the fallback for a
 * missing `AGENTS.md`, the one in the user's home directory included) and
 * `.claude` skills out of the session.
 */
const RUN_ENV = { OPENCODE_DISABLE_CLAUDE_CODE: '1' };
/**
 * Status and listing commands run in the system's temporary directory, and
 * the CLI reads project configuration from its working directory upwards. A
 * file planted there by someone else could name commands to start, so those
 * commands run with project configuration switched off. A question never
 * does: its project file is the one written here.
 */
const PROBE_ENV = { ...RUN_ENV, OPENCODE_DISABLE_PROJECT_CONFIG: '1' };

/** The variables through which the CLI's catalogue providers take a key from the environment. */
const KEY_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];
const isBillingVariable = (name: string): boolean => KEY_VARIABLES.includes(name);

/**
 * Replaces the CLI's coding-agent system prompt for the agent below. The CLI
 * still appends the working directory, the date and any `AGENTS.md` it finds
 * (the user's global one, and those between the work dir and the home
 * directory); the last sentence keeps them out of answers.
 */
export const OPENCODE_SYSTEM_PROMPT =
  'You are answering one question inside an application that shows the answers of several AI ' +
  'models side by side. Give a direct, complete answer in the language of the question. There ' +
  'is no project, repository or file system here and no follow-up conversation, so do not ask ' +
  'clarifying questions and do not offer further actions. You have no tools. Format the answer ' +
  'with Markdown where it helps. Context that the command-line client attaches to the ' +
  'question, such as a working directory or instruction files, is not part of the question ' +
  'and must never be repeated in the answer.';

/**
 * The project configuration written into the work dir of one question. It
 * defines the agent the question is answered with and nothing about
 * providers, models or credentials, which stay where the user configured
 * them.
 *
 * - The agent's own rule denies every permission. Agent rules are applied
 *   after the user's global rules, so a global "allow" does not reopen a tool.
 * - The policies remove what a rule cannot: MCP servers are not started,
 *   skills are not listed, the web search has no provider. A policy only
 *   tightens, and a broader configuration of the user outranks this file.
 * - No snapshots: the work dir is not a project to undo changes in.
 */
export function buildOpencodeProjectConfig(): string {
  const deny = (action: string) => ({ action, resource: '*', effect: 'deny' });
  return `${JSON.stringify(
    {
      agents: {
        [OPENCODE_AGENT]: {
          description: 'Answers one question in text, without tools.',
          mode: 'primary',
          system: OPENCODE_SYSTEM_PROMPT,
          permissions: [deny('*')],
        },
      },
      policies: [deny('tool.use'), deny('mcp.use'), deny('skill.use'), deny('websearch.use')],
      snapshots: false,
    },
    null,
    2,
  )}\n`;
}

/**
 * The model reference of a run: `provider/model`, with the variant after a
 * `#` when the model name carries one or an effort was chosen (the CLI's name
 * for an effort level is a variant of a model). `undefined` leaves the choice
 * to the CLI's own configuration.
 */
export function opencodeModelReference(selection: {
  model?: string;
  effort?: string;
}): string | undefined {
  if (selection.model === undefined) return undefined;
  const [name = '', ownVariant] = selection.model.split('#');
  const variant = selection.effort ?? ownVariant;
  return variant === undefined ? name : `${name}#${variant}`;
}

/**
 * The headless invocation: one message read from stdin, answered by the
 * tool-less agent on a private server that ends with this process, printed
 * as JSON events. `--title` keeps the CLI from asking the model for a
 * session title, which would be a second request per question.
 */
export function buildOpencodeArgs(selection: { model?: string; effort?: string }): string[] {
  const reference = opencodeModelReference(selection);
  return [
    'run',
    '--standalone',
    '--format',
    'json',
    '--thinking',
    '--archived',
    '--title',
    BRAND.name,
    '--agent',
    OPENCODE_AGENT,
    ...(reference === undefined ? [] : ['--model', reference]),
  ];
}

export const OPENCODE_VERSION_ARGS = ['--version'];
export const OPENCODE_STATUS_ARGS = ['auth', 'list', '--standalone', '--format', 'json'];
export const OPENCODE_MODELS_ARGS = ['models', '--standalone'];

/** What the CLI's own error types mean here; the others are judged by their message. */
const ERROR_CODES: Record<string, ProviderErrorCode> = {
  'provider.auth': 'not_logged_in',
  'provider.quota': 'quota',
  'provider.rate-limit': 'rate_limited',
  'provider.transport': 'network',
  'provider.no-route': 'model_not_found',
};

const AGENT_NOT_LOADED: Failure = {
  code: 'unsupported',
  message:
    'opencode did not load the agent that switches its tools off, so nothing was sent. ' +
    'Its project configuration is probably disabled on this machine (OPENCODE_DISABLE_PROJECT_CONFIG).',
};
const OLD_VERSION: Failure = {
  code: 'unsupported',
  message: `This opencode does not accept the arguments used here. Version ${SUPPORTED_MAJOR} or later is needed.`,
};

function failureOf(value: unknown): NonNullable<ParserOutcome['failure']> {
  if (!isRecord(value)) return { message: text(value) ?? 'The CLI reported an error.' };
  const message = text(value.message) ?? 'The CLI reported an error.';
  if (/^Agent not found/i.test(message)) return AGENT_NOT_LOADED;
  const type = text(value.type) ?? '';
  const status = tokenCount(value.status);
  const code =
    ERROR_CODES[type] ??
    (type === 'provider.invalid-request' && status === 404 ? 'model_not_found' : undefined);
  return {
    ...(code === undefined ? {} : { code }),
    message: status === undefined ? message : `${message} (HTTP ${status})`,
  };
}

/** Usage of one model step; the CLI counts reasoning and cached tokens apart. */
function stepUsage(value: unknown): { input: number; output: number; reasoning: number } | null {
  if (!isRecord(value)) return null;
  const cache = isRecord(value.cache) ? value.cache : {};
  const counts = [value.input, cache.read, cache.write, value.output, value.reasoning].map(
    tokenCount,
  );
  if (counts.every((count) => count === undefined)) return null;
  const [input = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0] = counts;
  return { input: input + cacheRead + cacheWrite, output: output + reasoning, reasoning };
}

const toolName = (value: unknown): string =>
  (text(value) ?? 'unknown').replace(/[^\w .:-]/g, '').slice(0, 64) || 'unknown';

/**
 * Maps `run --format json` lines. A turn is a series of steps; each ends with
 * `step_finish`, and the one whose reason is not `tool-calls` ends the
 * answer. There is no event after it: the process just exits with code 0. A
 * failure is one `error` line and exit code 1, after `retry` lines when the
 * CLI first tried again on its own.
 */
export function createOpencodeParser(): StreamParser {
  const sent = new Map<string, number>();
  const noticed = new Set<string>();
  let anonymousParts = 0;
  let answerPart: string | undefined;
  let completed = false;
  let failure: ParserOutcome['failure'];
  const total = { input: 0, output: 0, reasoning: 0 };
  let counted = false;

  /** A part is printed once, whole; a version that repeats a growing part works too. */
  const growth = (part: Record<string, unknown>): { key: string; chunk: string } => {
    const key = text(part.id) ?? `#${anonymousParts++}`;
    const full = text(part.text) ?? '';
    const already = sent.get(key) ?? 0;
    if (full.length <= already) return { key, chunk: '' };
    sent.set(key, full.length);
    return { key, chunk: full.slice(already) };
  };

  const once = (key: string, message: string): ContentEvent[] => {
    if (noticed.has(key)) return [];
    noticed.add(key);
    return [{ type: 'notice', message }];
  };

  return {
    event(value) {
      const part = isRecord(value.part) ? value.part : {};
      switch (value.type) {
        case 'text': {
          const { key, chunk } = growth(part);
          if (chunk === '') return [];
          // An answer after a refused tool call is a second part of the same answer.
          const separator = answerPart !== undefined && answerPart !== key ? '\n\n' : '';
          answerPart = key;
          return [{ type: 'delta', text: separator + chunk }];
        }
        case 'reasoning': {
          const { chunk } = growth(part);
          return chunk === '' ? [] : [{ type: 'reasoning', text: `${chunk}\n` }];
        }
        case 'tool_use': {
          const name = toolName(part.tool);
          const refused = isRecord(part.state) && part.state.status === 'error';
          return once(
            `tool:${name}:${refused}`,
            refused
              ? `The model asked for a tool (${name}). Tools are switched off, so the call was refused.`
              : `The model used a tool (${name}) although tools are switched off for this agent. Check the opencode configuration on this machine.`,
          );
        }
        case 'retry': {
          const reason = isRecord(value.error)
            ? sanitizeDiagnostic(text(value.error.message) ?? '', 120)
            : '';
          return once(
            'retry',
            `The model provider reported an error${reason === '' ? '' : ` (${reason})`}. The CLI is trying again on its own.`,
          );
        }
        case 'step_finish': {
          const usage = stepUsage(part.tokens);
          if (usage) {
            counted = true;
            total.input += usage.input;
            total.output += usage.output;
            total.reasoning += usage.reasoning;
          }
          if (part.reason !== 'tool-calls') completed = true;
          return [];
        }
        case 'error':
          failure = failureOf(value.error);
          return [];
        default:
          return [];
      }
    },
    outcome(): ParserOutcome {
      const usage: Usage | undefined = counted
        ? {
            inputTokens: total.input,
            outputTokens: total.output,
            ...(total.reasoning === 0 ? {} : { reasoningTokens: total.reasoning }),
          }
        : undefined;
      return {
        completed: completed && failure === undefined,
        ...(usage ? { usage } : {}),
        ...(failure === undefined ? {} : { failure }),
      };
    },
  };
}

/**
 * Reads `opencode auth list --format json`: an array of integrations, each
 * with its `connections`. Only whether any connection exists is taken from
 * it; names and labels are never kept. No connection is not "logged out": a
 * provider that needs no key, or takes one from the CLI's own configuration,
 * is not listed.
 */
export function parseOpencodeAuthList(stdout: string): LoginState {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!Array.isArray(value)) return 'unknown';
    return value.some(
      (entry) =>
        isRecord(entry) && Array.isArray(entry.connections) && entry.connections.length > 0,
    )
      ? 'yes'
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

const MAX_MODELS = 200;

/** Reads `opencode models`: one `provider/model` reference per line. */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[^/\s]+\/\S+$/.test(line) && isModelArgument(line));
  return [...new Set(ids)].slice(0, MAX_MODELS).map((id) => ({ id }));
}

/** `start` and the error for a selection that cannot be passed on; `undefined` when it is fine. */
function rejectedSelection(
  request: Pick<RunRequest, 'model' | 'effort'>,
): ProviderEvent[] | undefined {
  const reject = (code: 'model_not_found' | 'unsupported', message: string): ProviderEvent[] => [
    { type: 'start', streaming: STREAMING },
    { type: 'error', code, message },
  ];
  if (request.model !== undefined) {
    const parts = request.model.split('#');
    const [name = '', variant] = parts;
    if (
      parts.length > 2 ||
      !isModelArgument(name) ||
      (variant !== undefined && !isEffortArgument(variant))
    ) {
      return reject(
        'model_not_found',
        'The model name contains characters a model reference cannot have. Use provider/model, or provider/model#variant.',
      );
    }
  }
  if (request.effort !== undefined && !isEffortArgument(request.effort)) {
    return reject(
      'unsupported',
      'The effort name contains characters an effort level cannot have.',
    );
  }
  if (request.effort !== undefined && request.model === undefined) {
    return reject(
      'unsupported',
      'This CLI selects an effort as a variant of a named model. Choose a model as well.',
    );
  }
  return undefined;
}

const majorOf = (version: string | undefined): number | undefined => {
  const major = Number(version?.split('.')[0]);
  return Number.isInteger(major) ? major : undefined;
};

export function createOpencodeAdapter(context: CliContext): ProviderAdapter {
  return {
    kind: 'opencode',
    toolAccess: 'disabled',
    loginCommand: LOGIN_COMMAND,

    async detect(instance): Promise<ProviderDetection> {
      const env = childEnvFor(context, instance, PROBE_ENV);
      const probe = await probeVersion(context, EXECUTABLE, OPENCODE_VERSION_ARGS, env, STREAMING);
      if (!probe.available) return probe.detection;
      const installed = {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        // A provider can be a plan sign-in, a key or a local endpoint; the CLI does not say which answers.
        billing: 'unknown' as const,
        streaming: STREAMING,
      };
      const major = majorOf(probe.version);
      if (major !== undefined && major < SUPPORTED_MAJOR) {
        return {
          ...installed,
          loggedIn: 'unknown',
          hint: `This is opencode ${major}. Questions need opencode ${SUPPORTED_MAJOR} or later, whose headless mode and permission rules are the ones used here.`,
        };
      }
      const status = await captureCli(EXECUTABLE, OPENCODE_STATUS_ARGS, env, context);
      const loggedIn =
        status.outcome === 'exited' && status.code === 0
          ? parseOpencodeAuthList(status.stdout)
          : 'unknown';
      const billing = billingReport(context, instance, isBillingVariable, 'unknown');
      return {
        ...installed,
        loggedIn,
        ...joinHints(
          loggedIn === 'yes'
            ? undefined
            : `No connected provider is listed. One that needs no key, or is set up in opencode's own configuration, still works; otherwise run \`${LOGIN_COMMAND}\` in a terminal.`,
          'Without a model chosen here, opencode uses its own default.',
          'It keeps questions and answers in its session database.',
          billing.hint,
        ),
      };
    },

    async listModels(instance): Promise<ModelInfo[]> {
      const result = await captureCli(
        EXECUTABLE,
        OPENCODE_MODELS_ARGS,
        childEnvFor(context, instance, PROBE_ENV),
        context,
      );
      return result.outcome === 'exited' && result.code === 0
        ? parseOpencodeModels(result.stdout)
        : [];
    },

    async *run(instance, request) {
      const rejected = rejectedSelection(request);
      if (rejected) {
        yield* rejected;
        return;
      }
      yield* runCli(
        {
          executable: EXECUTABLE,
          args: buildOpencodeArgs({
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
          }),
          env: childEnvFor(context, instance, RUN_ENV),
          stdin: request.prompt,
          files: [{ name: OPENCODE_PROJECT_FILE, content: buildOpencodeProjectConfig() }],
          parser: createOpencodeParser(),
          streaming: STREAMING,
          // Version 1 answers arguments it does not know with its usage text and exit code 1.
          knownFailure: (printed) =>
            /^opencode run \[message/m.test(printed) || /unknown (argument|option)/i.test(printed)
              ? OLD_VERSION
              : undefined,
        },
        request,
        context,
      );
    },
  };
}
