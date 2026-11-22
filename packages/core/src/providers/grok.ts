import path from 'node:path';
import type { ProviderAdapter } from '../contracts/index.ts';
import type {
  ModelInfo,
  ProviderDetection,
  StreamingMode,
  ToolAccess,
  Usage,
} from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { parseModelListing } from './cli/model-list.ts';
import { isRecord, runCli } from './cli/run-cli.ts';
import type { CliContext, ContentEvent, ParserOutcome, StreamParser } from './cli/run-cli.ts';
import {
  billingReport,
  childEnvFor,
  joinHints,
  probeVersion,
  rejectedSelection,
  text,
  tokenCount,
} from './cli/support.ts';

const EXECUTABLE = 'grok';
const LOGIN_COMMAND = 'grok login --device-auth';
/** `text` events carry fragments of the answer. */
const STREAMING: StreamingMode = 'token';
/** The documented switch for the CLI's cross-session memory. */
const EXTRA_ENV = { GROK_MEMORY: '0' };
/** The CLI does not read a prompt from stdin; it gets a file in the work dir. */
export const GROK_PROMPT_FILE = 'prompt.txt';

const isBillingVariable = (name: string): boolean => name === 'XAI_API_KEY';

/** The CLI documents a sandbox for Linux; only there is it part of the invocation. */
const sandboxed = (platform: NodeJS.Platform): boolean => platform === 'linux';

/**
 * The headless invocation: one turn, no planning, no sub-agents, an empty
 * tool allowlist, and a read-only sandbox where the CLI has one.
 */
export function buildGrokArgs(selection: {
  workDir: string;
  platform: NodeJS.Platform;
  model?: string;
}): string[] {
  const flavour = selection.platform === 'win32' ? path.win32 : path.posix;
  return [
    '--prompt-file',
    flavour.join(selection.workDir, GROK_PROMPT_FILE),
    '--output-format',
    'streaming-json',
    ...(selection.model === undefined ? [] : ['-m', selection.model]),
    '--cwd',
    selection.workDir,
    '--no-auto-update',
    '--max-turns',
    '1',
    '--no-plan',
    '--no-subagents',
    '--tools',
    '',
    ...(sandboxed(selection.platform) ? ['--sandbox', 'read-only'] : []),
  ];
}

export const GROK_VERSION_ARGS = ['version'];
export const GROK_MODELS_ARGS = ['models'];

function firstCount(source: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const count = tokenCount(source[name]);
    if (count !== undefined) return count;
  }
  return undefined;
}

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Usage = {};
  const input = firstCount(value, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
  const output = firstCount(value, [
    'outputTokens',
    'output_tokens',
    'completionTokens',
    'completion_tokens',
  ]);
  const reasoning = firstCount(value, ['reasoningTokens', 'reasoning_tokens', 'thoughtTokens']);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** The payload of a `text` or `thought` event: a string, or an object holding one. */
const fragment = (data: unknown): string =>
  text(data) ?? (isRecord(data) ? (text(data.text) ?? text(data.content) ?? '') : '');

/** Maps `--output-format streaming-json` lines; `end` is always the last one. */
export function createGrokParser(): StreamParser {
  const outcome: ParserOutcome = { completed: false };
  const noticed = new Set<string>();

  const recordUsage = (usage: Usage | undefined): ContentEvent[] => {
    if (usage) outcome.usage = usage;
    return [];
  };

  const toolCall = (value: Record<string, unknown>): ContentEvent[] => {
    const data = isRecord(value.data) ? value.data : value;
    const name = (text(data.name) ?? text(data.toolName) ?? text(data.title) ?? 'unknown')
      .replace(/[^\w .:-]/g, '')
      .slice(0, 64);
    if (noticed.has(name)) return [];
    noticed.add(name);
    return [{ type: 'notice', message: `The model tried to use a tool (${name}).` }];
  };

  return {
    event(value) {
      switch (value.type) {
        case 'text': {
          const chunk = fragment(value.data);
          return chunk === '' ? [] : [{ type: 'delta', text: chunk }];
        }
        case 'thought': {
          const chunk = fragment(value.data);
          return chunk === '' ? [] : [{ type: 'reasoning', text: chunk }];
        }
        case 'tool_call':
          return toolCall(value);
        case 'usage':
          return recordUsage(usageOf(value.data) ?? usageOf(value.usage) ?? usageOf(value));
        case 'error':
          outcome.failure = {
            message:
              text(value.message) ??
              (isRecord(value.data) ? text(value.data.message) : undefined) ??
              'The CLI reported an error.',
          };
          return [];
        case 'end': {
          outcome.completed = true;
          return recordUsage(
            usageOf(value.usage) ?? (isRecord(value.data) ? usageOf(value.data.usage) : undefined),
          );
        }
        default:
          return [];
      }
    },
    outcome: () => outcome,
  };
}

export function createGrokAdapter(context: CliContext): ProviderAdapter {
  const toolAccess: ToolAccess = sandboxed(context.platform) ? 'read-only' : 'unrestricted';
  return {
    kind: 'grok',
    toolAccess,
    loginCommand: LOGIN_COMMAND,

    async detect(instance): Promise<ProviderDetection> {
      const env = childEnvFor(context, instance, EXTRA_ENV);
      const probe = await probeVersion(context, EXECUTABLE, GROK_VERSION_ARGS, env, STREAMING);
      if (!probe.available) return probe.detection;
      const billing = billingReport(context, instance, isBillingVariable, 'unknown');
      return {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        // No status subcommand is documented, and the credentials are never inspected.
        loggedIn: 'unknown',
        // The CLI prefers its login session over an API key, so a kept key decides nothing by itself.
        billing: 'unknown',
        streaming: STREAMING,
        ...joinHints(
          `This CLI has no documented command that reports its login state. To sign in, run \`${LOGIN_COMMAND}\` in a terminal.`,
          billing.hint,
          billing.billing === 'api-key'
            ? 'The CLI uses the key only when it has no login session.'
            : undefined,
        ),
      };
    },

    async listModels(instance): Promise<ModelInfo[]> {
      const result = await captureCli(
        EXECUTABLE,
        GROK_MODELS_ARGS,
        childEnvFor(context, instance, EXTRA_ENV),
        context,
      );
      return result.outcome === 'exited' && result.code === 0
        ? parseModelListing(result.stdout)
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
          args: buildGrokArgs({
            workDir: request.workDir,
            platform: context.platform,
            ...(request.model === undefined ? {} : { model: request.model }),
          }),
          env: childEnvFor(context, instance, EXTRA_ENV),
          stdin: null,
          files: [{ name: GROK_PROMPT_FILE, content: request.prompt }],
          parser: createGrokParser(),
          streaming: STREAMING,
        },
        request,
        context,
      );
    },
  };
}
