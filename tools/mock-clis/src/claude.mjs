#!/usr/bin/env node
// Mock of the `claude` CLI: `--version`, `auth status --json` and the print
// mode with `--output-format stream-json`, as the adapter invokes them.
import {
  UsageError,
  loadFixture,
  logInvocation,
  main,
  parseFlags,
  play,
  readStdin,
  requireFlag,
  scenarioFor,
} from './lib/runtime.mjs';

const KIND = 'claude';
const WEB_SEARCH_TOOL = 'WebSearch';

const RUN_FLAGS = {
  '--print': 'boolean',
  '--output-format': 'value',
  '--verbose': 'boolean',
  '--include-partial-messages': 'boolean',
  '--tools': 'value',
  '--allowedTools': 'value',
  '--strict-mcp-config': 'boolean',
  '--safe-mode': 'boolean',
  '--restricted': 'boolean',
  '--disable-slash-commands': 'boolean',
  '--no-session-persistence': 'boolean',
  '--permission-prompts': 'value',
  '--system-prompt': 'value',
  '--model': 'value',
  '--effort': 'value',
};

const isStream = (event, type) => event.type === 'stream_event' && event.event.type === type;

/**
 * A complete successful answer whose text arrives as the given deltas: the
 * recorded `ok` run with its text replaced.
 */
function generate(pieces) {
  const whole = pieces.join('');
  let replaced = false;
  return loadFixture(KIND, 'ok').flatMap((line) => {
    const event = JSON.parse(line);
    if (isStream(event, 'content_block_delta')) {
      if (replaced) return [];
      replaced = true;
      return pieces.map((text) =>
        JSON.stringify({
          ...event,
          event: { ...event.event, delta: { type: 'text_delta', text } },
        }),
      );
    }
    if (event.type === 'assistant') event.message.content = [{ type: 'text', text: whole }];
    if (event.type === 'result') {
      event.result = whole;
      event.usage = { ...event.usage, output_tokens: pieces.length };
      for (const usage of Object.values(event.modelUsage)) usage.outputTokens = pieces.length;
    }
    return [JSON.stringify(event)];
  });
}

/** The `auth status --json` output; the identifying fields are here so that tests can prove they are dropped. */
function authStatus() {
  const loggedIn = scenarioFor(undefined) !== 'logged-out';
  const status = loggedIn
    ? {
        loggedIn: true,
        authMethod: process.env.ANTHROPIC_API_KEY
          ? 'api_key'
          : process.env.CLAUDE_CODE_OAUTH_TOKEN
            ? 'oauth_token'
            : 'claude.ai',
        apiProvider: 'firstParty',
        analyticsDisabled: false,
        projectsDirectory: '/home/mock/.claude/projects',
        configDirectory: '/home/mock/.claude',
        loginExpiresAt: '2099-01-01T00:00:00.000Z',
        consoleProfileSignInOffered: false,
        email: 'mock.user@example.com',
        orgId: 'org-mock-0001',
        orgName: 'Mock Organisation',
        subscriptionType: 'max',
        storedClaudeAiLogin: true,
        planTier: 'mock-tier',
      }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return loggedIn ? 0 : 1;
}

/** Whether the invocation offers the web search; anything but the two confirmed forms is refused. */
function webSearchRequested(flags) {
  requireFlag(flags, '--tools');
  if (flags['--tools'] === '' && flags['--allowedTools'] === undefined) return false;
  if (flags['--tools'] === WEB_SEARCH_TOOL && flags['--allowedTools'] === WEB_SEARCH_TOOL) {
    return true;
  }
  throw new UsageError(
    `--tools must be "" alone, or "${WEB_SEARCH_TOOL}" together with --allowedTools ${WEB_SEARCH_TOOL}`,
  );
}

main(KIND, async (argv) => {
  if (argv.length === 1 && argv[0] === '--version') {
    logInvocation(KIND);
    process.stdout.write('2.1.330 (Claude Code)\n');
    return 0;
  }
  if (argv.length === 3 && argv[0] === 'auth' && argv[1] === 'status' && argv[2] === '--json') {
    logInvocation(KIND);
    return authStatus();
  }

  const { flags, positionals } = parseFlags(argv, RUN_FLAGS, { '-p': '--print' });
  if (positionals.length > 0) {
    throw new UsageError(`the prompt must arrive on stdin, not as an argument: ${positionals[0]}`);
  }
  requireFlag(flags, '--print');
  requireFlag(flags, '--output-format', 'stream-json');
  // The real CLI refuses stream-json in print mode without it.
  requireFlag(flags, '--verbose');
  requireFlag(flags, '--include-partial-messages');
  const webSearch = webSearchRequested(flags);
  requireFlag(flags, '--strict-mcp-config');
  requireFlag(flags, '--safe-mode');
  requireFlag(flags, '--restricted');
  requireFlag(flags, '--disable-slash-commands');
  requireFlag(flags, '--no-session-persistence');
  requireFlag(flags, '--permission-prompts', 'none');
  requireFlag(flags, '--system-prompt');
  if (flags['--system-prompt'].trim() === '') {
    throw new UsageError('--system-prompt must not be empty');
  }
  if (process.env.ENABLE_CLAUDEAI_MCP_SERVERS !== 'false') {
    throw new UsageError('ENABLE_CLAUDEAI_MCP_SERVERS must be "false"');
  }
  const nested = Object.keys(process.env).filter(
    (name) => name === 'CLAUDECODE' || name === 'CLAUDE_CODE_ENTRYPOINT',
  );
  if (nested.length > 0) {
    throw new UsageError(`started inside another session (${nested.join(', ')} set)`);
  }

  const model = flags['--model'];
  const cli = {
    kind: KIND,
    generate,
    failures: {
      // Unconfirmed: these three were not provoked on a real CLI.
      'logged-out': { exitCode: 1 },
      quota: { exitCode: 1 },
      'rate-limited': { exitCode: 1 },
      // As recorded: exit code 1 and one diagnostic line on stderr.
      'model-not-found': {
        exitCode: 1,
        stderr: `[claude-code:unrecognized_model] ${JSON.stringify({ model, query_source: 'sdk' })}`,
      },
    },
  };
  const scenario = scenarioFor(model);
  if (scenario === 'hang') {
    logInvocation(KIND, { scenario });
    return play(cli, scenario, {});
  }
  const prompt = await readStdin();
  logInvocation(KIND, { scenario, prompt });
  const replay = async (name, adjust = (event) => event) => {
    const lines = loadFixture(KIND, name).map(
      (line) => `${JSON.stringify(adjust(JSON.parse(line)))}\n`,
    );
    await new Promise((resolve) => process.stdout.write(lines.join(''), resolve));
    return 0;
  };
  // With the search offered, the plain answer is the recorded run that used it.
  if (webSearch && scenario === 'ok') return replay('web-search');
  if (scenario === 'tool-denied') {
    // Recorded with the search tool offered; the init line lists what this invocation offers.
    return replay(scenario, (event) =>
      event.subtype === 'init' ? { ...event, tools: webSearch ? [WEB_SEARCH_TOOL] : [] } : event,
    );
  }
  return play(cli, scenario, { prompt });
});
