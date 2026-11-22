import type { ProviderAdapter } from '../contracts/index.ts';
import type { ModelInfo, ProviderDetection, StreamingMode, Usage } from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { parseModelListing } from './cli/model-list.ts';
import { isRecord, runCli } from './cli/run-cli.ts';
import type { CliContext, ContentEvent, ParserOutcome, StreamParser } from './cli/run-cli.ts';
import {
  billingReport,
  childEnvFor,
  cliSwitches,
  joinHints,
  probeVersion,
  rejectedSelection,
  text,
  tokenCount,
} from './cli/support.ts';

const EXECUTABLE = 'agy';
/** The CLI has no login subcommand: starting it interactively signs in. */
const LOGIN_COMMAND = 'agy';
/** `step_update` events carry `text_delta`. */
const STREAMING: StreamingMode = 'token';
/** The CLI updates itself in the background unless told not to; updating is the user's call. */
const EXTRA_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

const isBillingVariable = (name: string): boolean =>
  name === 'GEMINI_API_KEY' || name === 'GOOGLE_API_KEY';

/**
 * The headless invocation. The prompt travels on stdin as one stream-json
 * line, so `-p` only selects print mode and carries nothing. The CLI's own
 * time limit is always set: its default has changed between versions. Slash
 * commands are off so that a question starting with `/` stays a question.
 */
export function buildAgyArgs(selection: {
  timeoutMs: number;
  model?: string;
  effort?: string;
}): string[] {
  return [
    '-p',
    '',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--print-timeout',
    `${Math.max(1, Math.ceil(selection.timeoutMs / 1000))}s`,
    '--disable-slash-commands',
    ...(selection.model === undefined ? [] : ['--model', selection.model]),
    ...(selection.effort === undefined ? [] : ['--effort', selection.effort]),
  ];
}

/** The one line written to stdin before it is closed. */
export function buildAgyInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

export const AGY_VERSION_ARGS = ['--version'];
export const AGY_MODELS_ARGS = ['models'];

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  const thinking = tokenCount(value.thinking_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (thinking !== undefined) usage.reasoningTokens = thinking;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

const TOOL_STEP = /tool|command|exec|edit|file|search|browse|mcp|shell/i;

/** Maps `--output-format stream-json` lines: `init`, `step_update`, `result`. */
export function createAgyParser(): StreamParser {
  const outcome: ParserOutcome = { completed: false };
  const noticed = new Set<string>();
  let answered = false;

  const step = (value: Record<string, unknown>): ContentEvent[] => {
    const kind = text(value.step_type) ?? '';
    const delta = text(value.text_delta) ?? '';
    if (kind === 'agent_response') {
      if (delta === '') return [];
      answered = true;
      return [{ type: 'delta', text: delta }];
    }
    if (/think|reason/i.test(kind)) return delta === '' ? [] : [{ type: 'reasoning', text: delta }];
    if (!TOOL_STEP.test(kind) || noticed.has(kind)) return [];
    noticed.add(kind);
    return [
      {
        type: 'notice',
        message: `The model used a tool (${kind.replace(/[^\w-]/g, '')}). This CLI has no documented way to switch its tools off.`,
      },
    ];
  };

  const result = (value: Record<string, unknown>): ContentEvent[] => {
    const usage = usageOf(value.usage);
    if (usage) outcome.usage = usage;
    const status = text(value.status) ?? 'SUCCESS';
    if (status !== 'SUCCESS') {
      const said =
        text(value.error) ??
        (isRecord(value.error) ? text(value.error.message) : undefined) ??
        text(value.message);
      outcome.failure = {
        message: said || `The run ended with status ${status.replace(/[^\w-]/g, '')}.`,
      };
      return [];
    }
    outcome.completed = true;
    const whole = text(value.response) ?? text(value.text) ?? '';
    return answered || whole === '' ? [] : [{ type: 'delta', text: whole }];
  };

  return {
    event(value) {
      switch (value.type ?? value.event) {
        case 'step_update':
          return step(value);
        case 'result':
          return result(value);
        default:
          return [];
      }
    },
    outcome: () => outcome,
  };
}

export function createAgyAdapter(context: CliContext): ProviderAdapter {
  return {
    kind: 'agy',
    toolAccess: 'unrestricted',
    loginCommand: LOGIN_COMMAND,

    async detect(instance): Promise<ProviderDetection> {
      const env = childEnvFor(context, instance, EXTRA_ENV);
      const probe = await probeVersion(context, EXECUTABLE, AGY_VERSION_ARGS, env, STREAMING);
      if (!probe.available) return probe.detection;
      const billing = billingReport(context, instance, isBillingVariable, 'unknown');
      return {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        // No status subcommand exists, and the credentials are never inspected.
        loggedIn: 'unknown',
        billing: billing.billing,
        streaming: STREAMING,
        ...joinHints(
          `This CLI has no command that reports its login state. To sign in, start \`${LOGIN_COMMAND}\` in a terminal.`,
          billing.hint,
        ),
      };
    },

    async listModels(instance): Promise<ModelInfo[]> {
      const result = await captureCli(
        EXECUTABLE,
        AGY_MODELS_ARGS,
        childEnvFor(context, instance, EXTRA_ENV),
        context,
      );
      return result.outcome === 'exited' && result.code === 0
        ? parseModelListing(result.stdout)
        : [];
    },

    async *run(instance, request) {
      if (!cliSwitches(instance).riskAcknowledged) {
        yield { type: 'start', streaming: STREAMING };
        yield {
          type: 'error',
          code: 'unsupported',
          message:
            'This provider stays off until its notice has been acknowledged in the settings.',
        };
        return;
      }
      const rejected = rejectedSelection(request, STREAMING);
      if (rejected) {
        yield* rejected;
        return;
      }
      yield* runCli(
        {
          executable: EXECUTABLE,
          args: buildAgyArgs(request),
          env: childEnvFor(context, instance, EXTRA_ENV),
          stdin: buildAgyInput(request.prompt),
          parser: createAgyParser(),
          streaming: STREAMING,
        },
        request,
        context,
      );
    },
  };
}
