#!/usr/bin/env node
// Manual smoke test against the REAL command-line tools installed on this
// machine. Every call sends one prompt to a vendor through the owner's own
// login and counts against that subscription (or API key).
//
// Never run by CI and never started by another script: `pnpm smoke:real` is
// the only entry (tools/mock-clis/src/real-smoke-guard.test.ts enforces it).
// It refuses to run inside CI, and without `--yes` or a typed confirmation.
//
// For each CLI that is installed and logged in it sends exactly one tiny
// prompt through the compiled adapter (`packages/core/dist`): the same
// argument builder, child environment and parser as the server. One call per
// CLI, one after the other, no retries.
//
//   pnpm smoke:real --yes                  every installed, logged-in CLI
//   pnpm smoke:real --yes --only codex     one CLI
//   pnpm smoke:real --yes --search         the web search variant
//
// Run `pnpm build` first (`pnpm smoke:real` does both).

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CORE = path.join(ROOT, 'packages', 'core', 'dist');
const KINDS = ['claude', 'codex', 'agy', 'grok'];
const ADAPTER_FACTORIES = {
  claude: 'createClaudeAdapter',
  codex: 'createCodexAdapter',
  agy: 'createAgyAdapter',
  grok: 'createGrokAdapter',
};

const PROMPT = 'Reply with the single word OK and nothing else.';
const SEARCH_PROMPT =
  'Search the web for the newest Node.js release line that is marked Current and reply with its major version number only.';
const DEFAULT_TIMEOUT_SECONDS = 180;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

const USAGE = `Usage: pnpm smoke:real [options]

Sends one tiny prompt to each real CLI that is installed and logged in, through
the compiled adapter, and checks what came back. Every call uses your own
subscription (or API key) with that vendor.

Options:
  --yes              run without asking for confirmation
  --only <kind>      call one CLI only: ${KINDS.join(', ')}
  --search           use the web search variant (CLIs that have the switch)
  --model <id>       the model to ask for; needs --only (default: the CLI's own)
  --timeout <sec>    give up on a call after this long (default ${DEFAULT_TIMEOUT_SECONDS})
  --help             show this text
`;

// ------------------------------------------------------------------ output

const out = (text = '') => process.stdout.write(`${text}\n`);

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const line = (row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [
    line(rows[0]),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.slice(1).map(line),
  ].join('\n');
}

/** One printable line of bounded length; what a model answered is never trusted to be short. */
function oneLine(text, max = 120) {
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// --------------------------------------------------------------- arguments

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    yes: false,
    search: false,
    help: false,
    only: undefined,
    model: undefined,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  };
  const value = (name, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--':
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--search':
        options.search = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--only':
        options.only = value(arg, index++);
        if (!KINDS.includes(options.only)) {
          throw new UsageError(`--only takes one of: ${KINDS.join(', ')}`);
        }
        break;
      case '--model':
        options.model = value(arg, index++);
        break;
      case '--timeout': {
        const seconds = Number(value(arg, index++));
        if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
          throw new UsageError('--timeout takes a number of seconds between 5 and 3600');
        }
        options.timeoutSeconds = seconds;
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.model !== undefined && options.only === undefined) {
    throw new UsageError('--model needs --only, because model names differ per CLI');
  }
  return options;
}

// ------------------------------------------------------------------ checks

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function jsonLines(lines) {
  return lines.flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

const list = (value) => (Array.isArray(value) ? value : undefined);
const isEmptyList = (value) => Array.isArray(value) && value.length === 0;
const sameList = (value, expected) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

/** Checks every CLI must pass: what the adapter yielded for one prompt. */
function commonChecks(events) {
  const answer = events
    .flatMap((event) => (event.type === 'delta' ? [event.text] : []))
    .join('')
    .trim();
  const terminal = events.filter((event) => event.type === 'done' || event.type === 'error');
  const last = events.at(-1);
  return [
    { name: 'the run started', ok: events[0]?.type === 'start' },
    { name: 'an answer arrived', ok: answer !== '' },
    {
      name: 'exactly one terminal event arrived, and it is the last one',
      ok: terminal.length === 1 && terminal[0] === last,
    },
    {
      name: 'the run ended without an error',
      ok: last?.type === 'done',
      detail: last?.type === 'error' ? `${last.code}: ${oneLine(last.message)}` : undefined,
    },
  ];
}

/**
 * claude: what its own init line says about the session. The plugins the CLI
 * ships with (`path: "builtin"`) and its built-in agent types are always
 * listed and are inert without a tool, so they are not a failure.
 */
function claudeChecks(lines, events, search) {
  const records = jsonLines(lines);
  const init = records.find((record) => record.type === 'system' && record.subtype === 'init');
  const result = records.find((record) => record.type === 'result');
  const expectedTools = search ? ['WebSearch'] : [];
  const foreignPlugins = (list(init?.plugins) ?? []).filter(
    (plugin) => !isRecord(plugin) || plugin.path !== 'builtin',
  );
  const searched = records.some(
    (record) =>
      record.type === 'assistant' &&
      (list(record.message?.content) ?? []).some(
        (block) => isRecord(block) && block.type === 'tool_use' && block.name === 'WebSearch',
      ),
  );
  const checks = [
    { name: 'the CLI printed its init line', ok: init !== undefined },
    {
      name: search ? 'init: the only tool is WebSearch' : 'init: no tools',
      ok: sameList(init?.tools, expectedTools),
      detail: `${list(init?.tools)?.length ?? 'no'} tool(s) listed`,
    },
    {
      name: 'init: no MCP servers',
      ok: isEmptyList(init?.mcp_servers),
      detail: `${list(init?.mcp_servers)?.length ?? 'no'} listed`,
    },
    {
      name: 'init: no skills',
      ok: isEmptyList(init?.skills),
      detail: `${list(init?.skills)?.length ?? 'no'} listed`,
    },
    {
      name: 'init: no slash commands',
      ok: isEmptyList(init?.slash_commands),
      detail: `${list(init?.slash_commands)?.length ?? 'no'} listed`,
    },
    {
      name: 'init: every plugin is one the CLI ships with',
      ok: init !== undefined && foreignPlugins.length === 0,
      detail: `${foreignPlugins.length} other plugin(s)`,
    },
    {
      name: 'the result line reports success',
      ok: result !== undefined && result.is_error !== true,
    },
    {
      name: 'the adapter raised no notice about extras',
      ok: !events.some((event) => event.type === 'notice' && /extras/.test(event.message)),
    },
  ];
  if (search) checks.push({ name: 'the model searched the web', ok: searched });
  return checks;
}

/**
 * codex: what a run can show. The tools that cannot be removed never appear
 * in the output unless the model uses one, so the check is that no item other
 * than a message (and, with --search, a web search) was printed.
 */
function codexChecks(lines, _events, search) {
  const records = jsonLines(lines);
  const allowed = ['agent_message', 'reasoning', ...(search ? ['web_search'] : [])];
  const itemTypes = records
    .filter((record) => typeof record.type === 'string' && record.type.startsWith('item.'))
    .map((record) => (isRecord(record.item) ? String(record.item.type) : 'unknown'));
  const unexpected = [...new Set(itemTypes.filter((type) => !allowed.includes(type)))];
  const completed = records.find((record) => record.type === 'turn.completed');
  const checks = [
    { name: 'the turn completed', ok: completed !== undefined },
    {
      name: search
        ? 'no item other than messages and web searches'
        : 'no tool item of any kind (no command, file change, MCP call, sub-agent, web search)',
      ok: unexpected.length === 0,
      detail: unexpected.length === 0 ? undefined : `unexpected: ${unexpected.join(', ')}`,
    },
    {
      name: 'usage was reported',
      ok: isRecord(completed?.usage) && typeof completed.usage.input_tokens === 'number',
      detail: isRecord(completed?.usage)
        ? `${String(completed.usage.input_tokens)} input tokens`
        : undefined,
    },
  ];
  if (search) {
    checks.push({ name: 'the model searched the web', ok: itemTypes.includes('web_search') });
  }
  return checks;
}

const KIND_CHECKS = { claude: claudeChecks, codex: codexChecks };

// -------------------------------------------------------------------- main

async function confirm() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Type "yes" to send these prompts: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return EXIT_REFUSED;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    process.stderr.write('smoke:real never runs in CI: it would use a real account.\n');
    return EXIT_REFUSED;
  }

  const modules = {
    protocol: path.join(CORE, 'protocol', 'index.js'),
    system: path.join(CORE, 'system.js'),
    killTree: path.join(CORE, 'providers', 'cli', 'kill-tree.js'),
    ...Object.fromEntries(KINDS.map((kind) => [kind, path.join(CORE, 'providers', `${kind}.js`)])),
  };
  for (const file of Object.values(modules)) {
    if (!existsSync(file)) {
      process.stderr.write(`${path.relative(ROOT, file)} is missing: run pnpm build\n`);
      return EXIT_REFUSED;
    }
  }
  const load = (name) => import(pathToFileURL(modules[name]).href);
  const { createDefaultSettings, webSearchSupport } = await load('protocol');
  const { systemClock } = await load('system');
  const { killChildProcessTrees } = await load('killTree');

  // The context the server builds in providers/index.ts, plus the line observer.
  const shutdown = new AbortController();
  const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
  let stdoutLines = [];
  const context = {
    env: process.env,
    platform: process.platform,
    clock: systemClock,
    logger: silent,
    shutdownSignal: shutdown.signal,
    onStdoutLine: (line) => stdoutLines.push(line),
  };

  const wanted = options.only === undefined ? KINDS : [options.only];
  const defaults = createDefaultSettings().providers;
  const plan = [];
  for (const kind of wanted) {
    const named = options.only === kind;
    const searchable = webSearchSupport(kind) === 'available';
    const instance = {
      ...defaults.find((provider) => provider.id === kind),
      enabled: true,
      riskAcknowledged: kind === 'agy' && named,
      webSearch: options.search && searchable,
    };
    const entry = { kind, instance, call: false, reason: '', version: '', billing: '' };
    plan.push(entry);
    if (options.search && !searchable) {
      entry.reason = 'web search is not available for this CLI';
      continue;
    }
    if (kind === 'agy' && !named) {
      // Its vendor does not support wrapping it under consumer plans; never started unasked.
      entry.reason = 'only with --only agy (see the vendor notice in the README)';
      continue;
    }
    const adapter = (await load(kind))[ADAPTER_FACTORIES[kind]](context);
    entry.adapter = adapter;
    // The CLI's own version and status commands: no prompt is sent.
    const detection = await adapter.detect(instance);
    entry.version = detection.version ?? '';
    entry.billing = detection.billing ?? 'unknown';
    if (!detection.installed) entry.reason = 'not installed';
    else if (detection.loggedIn === 'no') entry.reason = 'not logged in';
    else if (detection.loggedIn === 'unknown' && !named) {
      entry.reason = `login state unknown; name it with --only ${kind} to call it anyway`;
    } else entry.call = true;
  }

  const calls = plan.filter((entry) => entry.call);
  out('Real CLI smoke test');
  out();
  out(
    table([
      ['CLI', 'version', 'billing', 'plan'],
      ...plan.map((entry) => [
        entry.kind,
        entry.version || '-',
        entry.call ? entry.billing : '-',
        entry.call
          ? `1 prompt${entry.instance.webSearch ? ' with web search' : ''}${options.model ? `, model ${options.model}` : ''}`
          : `skipped: ${entry.reason}`,
      ]),
    ]),
  );
  out();
  if (calls.length === 0) {
    out('Nothing to call, so nothing was tested.');
    return EXIT_FAILED;
  }
  out(
    `This sends ${calls.length} real prompt(s), one per CLI: ${calls.map((entry) => entry.kind).join(', ')}.`,
  );
  out("Each call goes to the vendor through your own login and uses that account's");
  out('subscription allowance (or bills the API key, where the table says api-key).');
  out('One call per CLI, one after the other, no retries.');
  out();
  if (!options.yes && !(await confirm())) {
    process.stderr.write(
      'Not confirmed; nothing was sent. Pass --yes to run without the question.\n',
    );
    return EXIT_REFUSED;
  }

  let interrupted = false;
  let current;
  const interrupt = () => {
    interrupted = true;
    current?.abort();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('exit', () => killChildProcessTrees());

  const results = [];
  const prompt = options.search ? SEARCH_PROMPT : PROMPT;
  for (const entry of calls) {
    if (interrupted) {
      results.push({ kind: entry.kind, checks: [], note: 'not called: interrupted' });
      continue;
    }
    out(`[${entry.kind}] sending one prompt…`);
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'answerwall-smoke-real-'));
    const abort = new AbortController();
    current = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, options.timeoutSeconds * 1000);
    stdoutLines = [];
    const events = [];
    const startedAt = Date.now();
    try {
      const run = entry.adapter.run(entry.instance, {
        prompt,
        ...(options.model === undefined ? {} : { model: options.model }),
        timeoutMs: options.timeoutSeconds * 1000,
        signal: abort.signal,
        workDir,
      });
      for await (const event of run) events.push(event);
    } finally {
      clearTimeout(timer);
      current = undefined;
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    const checks = [
      ...commonChecks(events),
      ...(KIND_CHECKS[entry.kind]?.(stdoutLines, events, entry.instance.webSearch) ?? []),
    ];
    const answer = events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');
    const notices = events.flatMap((event) => (event.type === 'notice' ? [event.message] : []));
    const done = events.find((event) => event.type === 'done');
    for (const check of checks) {
      out(
        `  ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail && !check.ok ? ` (${check.detail})` : ''}`,
      );
    }
    for (const notice of notices) out(`  notice: ${oneLine(notice, 200)}`);
    if (answer.trim() !== '') out(`  answer: ${oneLine(answer)}`);
    if (done?.usage) {
      out(
        `  usage: ${done.usage.inputTokens ?? '?'} in, ${done.usage.outputTokens ?? '?'} out; ${Date.now() - startedAt} ms`,
      );
    }
    results.push({
      kind: entry.kind,
      checks,
      note: timedOut
        ? `timed out after ${options.timeoutSeconds} s`
        : interrupted
          ? 'interrupted'
          : '',
    });
  }
  shutdown.abort();

  out();
  out(
    table([
      ['CLI', 'result', 'checks', 'first failure'],
      ...plan.map((entry) => {
        const result = results.find((candidate) => candidate.kind === entry.kind);
        if (!result) return [entry.kind, 'skipped', '-', entry.reason];
        const failed = result.checks.filter((check) => !check.ok);
        const passed = result.checks.length > 0 && failed.length === 0;
        return [
          entry.kind,
          passed ? 'PASS' : 'FAIL',
          `${result.checks.length - failed.length}/${result.checks.length}`,
          result.note ||
            (failed[0]
              ? `${failed[0].name}${failed[0].detail ? ` (${failed[0].detail})` : ''}`
              : ''),
        ];
      }),
    ]),
  );
  const failed = results.some(
    (result) => result.checks.length === 0 || result.checks.some((check) => !check.ok),
  );
  return failed || interrupted ? EXIT_FAILED : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`smoke:real failed unexpectedly: ${error?.stack ?? String(error)}\n`);
    process.exitCode = EXIT_FAILED;
  },
);
