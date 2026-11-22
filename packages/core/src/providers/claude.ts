import type { ProviderAdapter } from '../contracts/index.ts';
import type {
  BillingSource,
  LoginState,
  ProviderDetection,
  ProviderErrorCode,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { hasVariable, LOGIN_TOKEN_VARIABLE } from './cli/child-env.ts';
import { isRecord, parseJsonLine, runCli } from './cli/run-cli.ts';
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

const EXECUTABLE = 'claude';
const LOGIN_COMMAND = 'claude auth login';
/** `--include-partial-messages` makes the CLI forward the API's text deltas. */
const STREAMING: StreamingMode = 'token';
/** Keeps the account's claude.ai connectors out of the session. */
const EXTRA_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

const isBillingVariable = (name: string): boolean =>
  name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_');

/**
 * The non-interactive invocation: answer one prompt read from stdin, with
 * every tool, MCP server, customisation and session file switched off.
 */
export function buildClaudeArgs(selection: { model?: string; effort?: string }): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    ...(selection.model === undefined ? [] : ['--model', selection.model]),
    ...(selection.effort === undefined ? [] : ['--effort', selection.effort]),
  ];
}

export const CLAUDE_VERSION_ARGS = ['--version'];
export const CLAUDE_STATUS_ARGS = ['auth', 'status'];

/** The `error` values of a `system`/`api_retry` event. */
const RETRY_ERROR_CODES: Record<string, ProviderErrorCode> = {
  authentication_failed: 'not_logged_in',
  oauth_org_not_allowed: 'not_logged_in',
  cloud_credential_error: 'not_logged_in',
  account_on_hold: 'quota',
  billing_error: 'quota',
  rate_limit: 'rate_limited',
  overloaded: 'rate_limited',
  model_not_found: 'model_not_found',
  server_error: 'network',
};

function usageOf(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = [
    value.input_tokens,
    value.cache_creation_input_tokens,
    value.cache_read_input_tokens,
  ]
    .map(tokenCount)
    .filter((count) => count !== undefined);
  const output = tokenCount(value.output_tokens);
  if (input.length === 0 && output === undefined) return undefined;
  return {
    ...(input.length === 0 ? {} : { inputTokens: input.reduce((sum, count) => sum + count, 0) }),
    ...(output === undefined ? {} : { outputTokens: output }),
  };
}

/**
 * Maps `--output-format stream-json` lines. Text and thinking come from the
 * partial `stream_event` deltas; when a message arrives without any (a CLI
 * that does not forward partials), its complete `assistant` line is used.
 */
export function createClaudeParser(): StreamParser {
  const outcome: ParserOutcome = { completed: false };
  const noticed = new Set<string>();
  let retryError: string | undefined;
  let limitRejected = false;
  let answered = false;
  let separatorDue = false;
  let streamedText = false;
  let streamedThinking = false;

  const notice = (key: string, message: string): ContentEvent[] => {
    if (noticed.has(key)) return [];
    noticed.add(key);
    return [{ type: 'notice', message }];
  };
  const answer = (chunk: string): ContentEvent[] => {
    if (chunk === '') return [];
    const prefix = separatorDue ? '\n\n' : '';
    separatorDue = false;
    answered = true;
    return [{ type: 'delta', text: prefix + chunk }];
  };
  const toolNotice = (name: unknown): ContentEvent[] => {
    const tool = text(name) ?? 'unknown';
    return notice(
      `tool:${tool}`,
      `The model asked for the tool "${tool}"; tools are switched off.`,
    );
  };

  const streamEvent = (event: unknown): ContentEvent[] => {
    if (!isRecord(event)) return [];
    if (event.type === 'message_start') {
      separatorDue = answered;
      return [];
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return [];
    const { delta } = event;
    if (delta.type === 'text_delta') {
      streamedText = true;
      return answer(text(delta.text) ?? '');
    }
    if (delta.type === 'thinking_delta') {
      streamedThinking = true;
      const thinking = text(delta.thinking) ?? '';
      return thinking === '' ? [] : [{ type: 'reasoning', text: thinking }];
    }
    return [];
  };

  const assistantMessage = (message: unknown): ContentEvent[] => {
    const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
    const events: ContentEvent[] = [];
    if (!streamedText) separatorDue = answered;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && !streamedText) events.push(...answer(text(block.text) ?? ''));
      if (block.type === 'thinking' && !streamedThinking) {
        const thinking = text(block.thinking) ?? '';
        if (thinking !== '') events.push({ type: 'reasoning', text: thinking });
      }
      if (block.type === 'tool_use') events.push(...toolNotice(block.name));
    }
    streamedText = false;
    streamedThinking = false;
    return events;
  };

  const result = (value: Record<string, unknown>): ContentEvent[] => {
    const usage = usageOf(value.usage);
    if (usage) outcome.usage = usage;
    const events: ContentEvent[] = [];
    for (const denial of Array.isArray(value.permission_denials) ? value.permission_denials : []) {
      if (isRecord(denial)) events.push(...toolNotice(denial.tool_name));
    }
    const said = text(value.result) ?? '';
    const subtype = text(value.subtype) ?? 'success';
    if (value.is_error === true || subtype !== 'success') {
      const errors = Array.isArray(value.errors)
        ? value.errors.filter((e) => typeof e === 'string')
        : [];
      const code = limitRejected
        ? 'quota'
        : retryError === undefined
          ? undefined
          : RETRY_ERROR_CODES[retryError];
      outcome.failure = {
        message: said || errors.join(' ') || `The run ended early (${subtype}).`,
        ...(code === undefined ? {} : { code }),
      };
      return events;
    }
    outcome.completed = true;
    if (!answered) events.push(...answer(said));
    return events;
  };

  return {
    event(value) {
      // Events of a sub-agent's conversation are not part of the answer.
      if (typeof value.parent_tool_use_id === 'string') return [];
      switch (value.type) {
        case 'stream_event':
          return streamEvent(value.event);
        case 'assistant':
          return assistantMessage(value.message);
        case 'result':
          return result(value);
        case 'rate_limit_event':
          if (isRecord(value.rate_limit_info) && value.rate_limit_info.status === 'rejected') {
            limitRejected = true;
          }
          return [];
        case 'system': {
          if (value.subtype !== 'api_retry') return [];
          retryError = text(value.error) ?? 'unknown';
          return notice(
            `retry:${retryError}`,
            `The CLI is retrying after an error from the service (${retryError.replace(/[^\w-]/g, '')}).`,
          );
        }
        default:
          return [];
      }
    },
    outcome: () => outcome,
  };
}

const API_KEY_METHODS = ['api_key', 'api_key_helper', 'third_party'];

/**
 * Reads `claude auth status`. Only the login flag and the authentication
 * method are looked at; the e-mail address, organisation and directories the
 * command also prints never leave this function.
 */
export function parseClaudeAuthStatus(
  stdout: string,
  exitCode: number | null,
): { loggedIn: LoginState; billing: BillingSource } {
  const status = parseJsonLine(stdout);
  const flag = status?.loggedIn;
  const loggedIn: LoginState =
    flag === true
      ? 'yes'
      : flag === false
        ? 'no'
        : exitCode === 0
          ? 'yes'
          : exitCode === 1
            ? 'no'
            : 'unknown';
  const method = text(status?.authMethod) ?? '';
  const provider = text(status?.apiProvider) ?? 'firstParty';
  let billing: BillingSource = 'unknown';
  if (loggedIn === 'yes') {
    if (API_KEY_METHODS.includes(method) || provider !== 'firstParty') billing = 'api-key';
    else if (method === 'claude.ai' || method === 'oauth_token') billing = 'subscription';
  }
  return { loggedIn, billing };
}

export function createClaudeAdapter(context: CliContext): ProviderAdapter {
  return {
    kind: 'claude',
    toolAccess: 'disabled',
    loginCommand: LOGIN_COMMAND,

    async detect(instance): Promise<ProviderDetection> {
      const env = childEnvFor(context, instance, EXTRA_ENV);
      const probe = await probeVersion(context, EXECUTABLE, CLAUDE_VERSION_ARGS, env, STREAMING);
      if (!probe.available) return probe.detection;
      const status = await captureCli(EXECUTABLE, CLAUDE_STATUS_ARGS, env, context);
      const { loggedIn, billing: fromLogin } =
        status.outcome === 'exited'
          ? parseClaudeAuthStatus(status.stdout, status.code)
          : { loggedIn: 'unknown' as const, billing: 'unknown' as const };
      const billing = billingReport(context, instance, isBillingVariable, fromLogin);
      return {
        installed: true,
        ...(probe.version === undefined ? {} : { version: probe.version }),
        loggedIn,
        billing: billing.billing,
        streaming: STREAMING,
        ...joinHints(
          loggedIn === 'no' ? `Not logged in. Run \`${LOGIN_COMMAND}\` in a terminal.` : undefined,
          loggedIn === 'unknown' ? 'The login state could not be determined.' : undefined,
          loggedIn === 'yes' && fromLogin === 'unknown'
            ? 'The CLI reports a login method this app does not recognise, so the billing source is unknown.'
            : undefined,
          hasVariable(context.env, context.platform, LOGIN_TOKEN_VARIABLE)
            ? `${LOGIN_TOKEN_VARIABLE} is set in the environment and is passed to the CLI as its own login.`
            : undefined,
          billing.hint,
        ),
      };
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
          args: buildClaudeArgs(request),
          env: childEnvFor(context, instance, EXTRA_ENV),
          stdin: request.prompt,
          parser: createClaudeParser(),
          streaming: STREAMING,
        },
        request,
        context,
      );
    },
  };
}
