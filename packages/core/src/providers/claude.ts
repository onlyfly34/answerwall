import type { ProviderAdapter } from '../contracts/index.ts';
import type {
  BillingSource,
  LoginState,
  ProviderDetection,
  ProviderErrorCode,
  StreamingMode,
  Usage,
} from '../protocol/index.ts';
import { LOGIN_COMMANDS } from '../protocol/index.ts';
import { captureCli } from './cli/capture.ts';
import { hasVariable, LOGIN_TOKEN_VARIABLE } from './cli/child-env.ts';
import { isRecord, parseJsonLine, runCli } from './cli/run-cli.ts';
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

const EXECUTABLE = 'claude';
const LOGIN_COMMAND = LOGIN_COMMANDS.claude;
/** `--include-partial-messages` makes the CLI forward the API's text deltas. */
const STREAMING: StreamingMode = 'token';
/** Keeps the account's claude.ai connectors out of the session. */
const EXTRA_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

const isBillingVariable = (name: string): boolean =>
  name.startsWith('ANTHROPIC_') || name.startsWith('CLAUDE_CODE_USE_');

/**
 * Replaces the CLI's coding-agent system prompt. Without it the model is
 * told about tools it does not have, and a plain question costs a few
 * thousand more input tokens. The CLI still attaches the account's e-mail
 * address and the working directory to the question; the last sentence keeps
 * them out of answers. Plain ASCII without quotes, so that it survives any
 * launcher's argument quoting.
 */
export const CLAUDE_SYSTEM_PROMPT =
  'You are answering one question inside an application that shows the answers of several AI ' +
  'models side by side. Give a direct, complete answer in the language of the question. There ' +
  'is no project, repository or file system here and no follow-up conversation, so do not ask ' +
  'clarifying questions and do not offer further actions. Format the answer with Markdown ' +
  'where it helps. Context that the command-line client attaches to the question, such as an ' +
  'account e-mail address or a working directory, is not part of the question and must never ' +
  'be repeated in the answer.';

/** The CLI's built-in search tool. It runs on the vendor's servers, not on this machine. */
const WEB_SEARCH_TOOL = 'WebSearch';

/** The levels `claude --help` lists for `--effort`. */
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ClaudeSelection {
  model?: string;
  effort?: string;
  /**
   * Offers the model the built-in web search and nothing else. Never the
   * fetch tool: that one makes its requests from this machine and could
   * reach addresses on the private network.
   */
  webSearch?: boolean;
}

/**
 * The non-interactive invocation: answer one prompt read from stdin, with
 * every tool, MCP server, customisation and session file switched off.
 * `--safe-mode` drops the user's customisations (instructions, skills,
 * plugins, hooks, MCP servers); `--restricted` drops the settings files and
 * the remaining built-in extras. A tool that is offered still needs an allow
 * rule, because nobody can answer a permission prompt here.
 */
export function buildClaudeArgs(selection: ClaudeSelection): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    selection.webSearch === true ? WEB_SEARCH_TOOL : '',
    ...(selection.webSearch === true ? ['--allowedTools', WEB_SEARCH_TOOL] : []),
    '--strict-mcp-config',
    '--safe-mode',
    '--restricted',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--system-prompt',
    CLAUDE_SYSTEM_PROMPT,
    ...(selection.model === undefined ? [] : ['--model', selection.model]),
    ...(selection.effort === undefined ? [] : ['--effort', selection.effort]),
  ];
}

export const CLAUDE_VERSION_ARGS = ['--version'];
export const CLAUDE_STATUS_ARGS = ['auth', 'status', '--json'];

/**
 * The `error` values of a `system`/`api_retry` event and of the message the
 * CLI prints in place of an answer when a request failed for good.
 */
const API_ERROR_CODES: Record<string, ProviderErrorCode> = {
  authentication_failed: 'not_logged_in',
  oauth_org_not_allowed: 'not_logged_in',
  cloud_credential_error: 'not_logged_in',
  verification_required: 'not_logged_in',
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
  // Thinking is billed as output; this is the part of `output_tokens` it took.
  const reasoning = isRecord(value.output_tokens_details)
    ? tokenCount(value.output_tokens_details.thinking_tokens)
    : undefined;
  if (input.length === 0 && output === undefined) return undefined;
  return {
    ...(input.length === 0 ? {} : { inputTokens: input.reduce((sum, count) => sum + count, 0) }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  };
}

/**
 * The usage of the whole run. `modelUsage` counts every request the CLI made
 * (a web search is a request of its own); `usage` only the main conversation,
 * so it is the fallback.
 */
function totalUsageOf(result: Record<string, unknown>): Usage | undefined {
  const models = isRecord(result.modelUsage)
    ? Object.values(result.modelUsage).filter(isRecord)
    : [];
  const total = (...fields: string[]): number | undefined => {
    const counts = models
      .flatMap((model) => fields.map((field) => tokenCount(model[field])))
      .filter((count) => count !== undefined);
    return counts.length === 0 ? undefined : counts.reduce((sum, count) => sum + count, 0);
  };
  const input = total('inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens');
  const output = total('outputTokens');
  const reasoning = total('thinkingTokens');
  if (input === undefined && output === undefined) return usageOf(result.usage);
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  };
}

const MAX_QUERY_LENGTH = 200;

/** A search query as one printable line of bounded length. */
function printableQuery(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  const query = (text(value) ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return query.length > MAX_QUERY_LENGTH ? `${query.slice(0, MAX_QUERY_LENGTH - 1)}…` : query;
}

/**
 * What the `init` line lists although the invocation switches it off. The
 * plugins the CLI ships with (`path: "builtin"`) and its built-in agent
 * types are always listed; without a tool to start them they are inert.
 */
function unexpectedExtras(init: Record<string, unknown>, allowedTools: string[]): string[] {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const tools = list(init.tools).filter(
    (tool) => typeof tool !== 'string' || !allowedTools.includes(tool),
  );
  const plugins = list(init.plugins).filter(
    (plugin) => !isRecord(plugin) || plugin.path !== 'builtin',
  );
  const count = (label: string, items: unknown[]): string[] =>
    items.length === 0 ? [] : [`${items.length} ${label}`];
  return [
    ...count('tool(s)', tools),
    ...count('MCP server(s)', list(init.mcp_servers)),
    ...count('skill(s)', list(init.skills)),
    ...count('command(s)', list(init.slash_commands)),
    ...count('plugin(s)', plugins),
  ];
}

/**
 * Maps `--output-format stream-json` lines. Text and thinking come from the
 * partial `stream_event` deltas; when a message arrives without any (a CLI
 * that does not forward partials), its complete `assistant` line is used.
 * The CLI prints one `assistant` line per content block. Thinking deltas are
 * empty on the CLI versions seen so far, so there is usually no reasoning
 * text, only its token count in the usage.
 */
export function createClaudeParser(options: { webSearch?: boolean } = {}): StreamParser {
  const webSearch = options.webSearch === true;
  const outcome: ParserOutcome = { completed: false };
  const noticed = new Set<string>();
  let retryError: string | undefined;
  let apiError: { error: string; message: string } | undefined;
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
  const isSearch = (name: unknown): boolean => webSearch && name === WEB_SEARCH_TOOL;
  /** A tool call that did not run: the tool is not offered, or the CLI refused it. */
  const refusedTool = (name: unknown): ContentEvent[] => {
    const tool = text(name) ?? 'unknown';
    return isSearch(tool)
      ? notice('denied:search', 'The CLI refused the web search.')
      : notice(`tool:${tool}`, `The model asked for the tool "${tool}"; tools are switched off.`);
  };
  const toolUse = (block: Record<string, unknown>): ContentEvent[] => {
    if (!isSearch(block.name)) return refusedTool(block.name);
    const query = printableQuery(isRecord(block.input) ? block.input.query : undefined);
    return notice(
      `search:${query}`,
      query === '' ? 'Searching the web…' : `Searching the web: ${query}`,
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

  const blocksOf = (message: unknown): Record<string, unknown>[] =>
    isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : [];

  /** The message the CLI makes up when a request failed: an error, not an answer. */
  const apiErrorMessage = (value: Record<string, unknown>): ContentEvent[] => {
    apiError = {
      error: text(value.error) ?? 'unknown',
      message: blocksOf(value.message)
        .map((block) => (block.type === 'text' ? (text(block.text) ?? '') : ''))
        .join(' ')
        .trim(),
    };
    return [];
  };

  const assistantMessage = (message: unknown): ContentEvent[] => {
    const content = blocksOf(message);
    const events: ContentEvent[] = [];
    if (!streamedText && content.some((block) => block.type === 'text')) separatorDue = answered;
    for (const block of content) {
      if (block.type === 'text' && !streamedText) events.push(...answer(text(block.text) ?? ''));
      if (block.type === 'thinking' && !streamedThinking) {
        const thinking = text(block.thinking) ?? '';
        if (thinking !== '') events.push({ type: 'reasoning', text: thinking });
      }
      if (block.type === 'tool_use') events.push(...toolUse(block));
    }
    streamedText = false;
    streamedThinking = false;
    return events;
  };

  const result = (value: Record<string, unknown>): ContentEvent[] => {
    const usage = totalUsageOf(value);
    if (usage) outcome.usage = usage;
    const events: ContentEvent[] = [];
    for (const denial of Array.isArray(value.permission_denials) ? value.permission_denials : []) {
      if (isRecord(denial)) events.push(...refusedTool(denial.tool_name));
    }
    const said = text(value.result) ?? '';
    const subtype = text(value.subtype) ?? 'success';
    if (value.is_error === true || subtype !== 'success') {
      const errors = Array.isArray(value.errors)
        ? value.errors.filter((e) => typeof e === 'string')
        : [];
      const reported = apiError?.error ?? retryError;
      const code = limitRejected
        ? 'quota'
        : reported === undefined
          ? undefined
          : API_ERROR_CODES[reported];
      outcome.failure = {
        message:
          said || errors.join(' ') || apiError?.message || `The run ended early (${subtype}).`,
        ...(code === undefined ? {} : { code }),
      };
      return events;
    }
    outcome.completed = true;
    if (!answered) events.push(...answer(said));
    return events;
  };

  const system = (value: Record<string, unknown>): ContentEvent[] => {
    switch (value.subtype) {
      case 'init': {
        const extras = unexpectedExtras(value, webSearch ? [WEB_SEARCH_TOOL] : []);
        return extras.length === 0
          ? []
          : notice(
              'extras',
              `The CLI started with extras that this app switches off (${extras.join(', ')}); they may affect the answer.`,
            );
      }
      case 'api_retry':
        retryError = text(value.error) ?? 'unknown';
        return notice(
          `retry:${retryError}`,
          `The CLI is retrying after an error from the service (${retryError.replace(/[^\w-]/g, '')}).`,
        );
      case 'permission_denied':
        return refusedTool(value.tool_name);
      default:
        // `status`, `thinking_tokens` and whatever else the CLI reports about its progress.
        return [];
    }
  };

  return {
    event(value) {
      // Events of a sub-agent's conversation are not part of the answer.
      if (typeof value.parent_tool_use_id === 'string') return [];
      switch (value.type) {
        case 'stream_event':
          return streamEvent(value.event);
        case 'assistant':
          return value.is_api_error_message === true || typeof value.error === 'string'
            ? apiErrorMessage(value)
            : assistantMessage(value.message);
        case 'result':
          return result(value);
        case 'rate_limit_event':
          // `overageStatus` may say "rejected" on an allowed request; only `status` counts.
          if (isRecord(value.rate_limit_info) && value.rate_limit_info.status === 'rejected') {
            limitRejected = true;
          }
          return [];
        case 'system':
          return system(value);
        default:
          // `user` lines carry tool results back to the model; they are not the answer.
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
      const { effort } = request;
      const { webSearch } = cliSwitches(instance);
      const events = runCli(
        {
          executable: EXECUTABLE,
          args: buildClaudeArgs({
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(effort === undefined ? {} : { effort }),
            webSearch,
          }),
          env: childEnvFor(context, instance, EXTRA_ENV),
          stdin: request.prompt,
          parser: createClaudeParser({ webSearch }),
          streaming: STREAMING,
        },
        request,
        context,
      );
      for await (const event of events) {
        yield event;
        // The CLI only warns on stderr about a level it does not know, and runs with its default.
        if (event.type === 'start' && effort !== undefined && !EFFORT_LEVELS.includes(effort)) {
          yield {
            type: 'notice',
            message: `The effort level "${effort}" is not one the CLI documents (${EFFORT_LEVELS.join(', ')}); it ignores an unknown level and uses its default.`,
          };
        }
      }
    },
  };
}
