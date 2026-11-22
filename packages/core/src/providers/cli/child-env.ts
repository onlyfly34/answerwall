import { BRAND } from '../../brand.ts';

/**
 * The CLI's own headless subscription login (`claude setup-token`). It is a
 * login method, not a session marker and not a billing switch, so it always
 * reaches the CLI as the user set it. Its value is never read, logged or stored.
 */
export const LOGIN_TOKEN_VARIABLE = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Settings that only matter together with a `CLAUDE_CODE_USE_*` billing
 * source. They travel with it: kept when the switch is on, removed otherwise.
 */
const BILLING_COMPANIONS: readonly string[] = [
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
];

/**
 * Variables that mark a nested coding-agent session. A CLI started with them
 * would believe it runs inside another session, so they are always removed.
 * The prefix is matched as a whole, so a marker this list has never heard of
 * is removed too. `AI_AGENT` is the same kind of marker under a generic name.
 * Not in this group: `CLAUDE_CODE_USE_*` and its companions
 * (a billing source) and the login token.
 */
function isNestedSessionVariable(name: string): boolean {
  return (
    name === 'CLAUDECODE' ||
    name === 'CLAUDE_EFFORT' ||
    name === 'CLAUDE_PID' ||
    name === 'AI_AGENT' ||
    (name.startsWith('CLAUDE_CODE_') &&
      !name.startsWith(BILLING_PREFIX) &&
      !BILLING_COMPANIONS.includes(name) &&
      name !== LOGIN_TOKEN_VARIABLE)
  );
}

/**
 * This application's own settings and secrets (the static token, the secret
 * overlay). No CLI needs them, and a CLI whose tools can read its environment
 * must never see them.
 */
const isOwnVariable = (name: string): boolean => name.startsWith(BRAND.envPrefix);

const BILLING_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
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

/** Whether a variable is set (non-empty) in `base`, by canonical name. */
export function hasVariable(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  wanted: string,
): boolean {
  return Object.entries(base).some(
    ([name, value]) => Boolean(value) && canonicalName(name, platform) === wanted,
  );
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
    if (isOwnVariable(canonical)) continue;
    if (isNestedSessionVariable(canonical)) continue;
    if (!options.keepApiKeys && isBillingVariable(canonical)) continue;
    if (!options.keepApiKeys && BILLING_COMPANIONS.includes(canonical)) continue;
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
