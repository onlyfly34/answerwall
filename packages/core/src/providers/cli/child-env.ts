/**
 * Variables that mark a nested coding-agent session. A CLI started with them
 * would believe it runs inside another session, so they are always removed.
 * `CLAUDE_CODE_USE_*` is not in this group: it selects a billing source.
 */
function isNestedSessionVariable(name: string): boolean {
  return (
    name === 'CLAUDECODE' ||
    name === 'CLAUDE_EFFORT' ||
    name === 'CLAUDE_PID' ||
    (name.startsWith('CLAUDE_CODE_') && !name.startsWith('CLAUDE_CODE_USE_'))
  );
}

const BILLING_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];
const BILLING_PREFIX = 'CLAUDE_CODE_USE_';

/**
 * Variables that silently move billing away from the CLI's own login. Removed
 * unless the provider's "use API key from environment" switch is on.
 */
export function isBillingVariable(name: string): boolean {
  return BILLING_VARIABLES.includes(name) || name.startsWith(BILLING_PREFIX);
}

/** Variable names are case-insensitive on Windows and conventionally upper case. */
const canonicalName = (name: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? name.toUpperCase() : name;

export interface ChildEnvOptions {
  /** The provider's "use API key from environment" switch. */
  keepApiKeys: boolean;
  platform: NodeJS.Platform;
  /** Adapter-specific variables, applied last. */
  extra?: Record<string, string>;
}

/** The environment of a CLI child process: the user's, scrubbed, plus fixed additions. */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  options: ChildEnvOptions,
): Record<string, string> {
  const additions: Record<string, string> = { NO_COLOR: '1', TERM: 'dumb', ...options.extra };
  const overridden = new Set(Object.keys(additions).map((n) => canonicalName(n, options.platform)));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const canonical = canonicalName(name, options.platform);
    if (isNestedSessionVariable(canonical)) continue;
    if (!options.keepApiKeys && isBillingVariable(canonical)) continue;
    if (overridden.has(canonical)) continue;
    env[name] = value;
  }
  return Object.assign(env, additions);
}

/**
 * The billing variables set (non-empty) in `base` that matter to one CLI, by
 * canonical name, sorted. `relevant` decides which ones matter.
 */
export function presentBillingVariables(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  relevant: (name: string) => boolean,
): string[] {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(base)) {
    const canonical = canonicalName(name, platform);
    if (value && isBillingVariable(canonical) && relevant(canonical)) names.add(canonical);
  }
  return [...names].sort();
}
