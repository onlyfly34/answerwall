import type { ProviderEvent, RunRequest } from '../../contracts/index.ts';
import { webSearchSupport } from '../../protocol/index.ts';
import type {
  BillingSource,
  ProviderDetection,
  ProviderInstance,
  StreamingMode,
} from '../../protocol/index.ts';
import { captureCli } from './capture.ts';
import type { CaptureResult } from './capture.ts';
import { buildChildEnv, presentBillingVariables } from './child-env.ts';
import type { CliContext } from './run-cli.ts';

/** The switches of a CLI provider instance; an instance of another kind has them off. */
export function cliSwitches(instance: ProviderInstance): {
  useEnvApiKey: boolean;
  riskAcknowledged: boolean;
  webSearch: boolean;
} {
  return instance.kind === 'openai-compat'
    ? { useEnvApiKey: false, riskAcknowledged: false, webSearch: false }
    : {
        useEnvApiKey: instance.useEnvApiKey,
        riskAcknowledged: instance.riskAcknowledged,
        // The schema refuses the switch for a kind without it; this holds even for a hand-built instance.
        webSearch: instance.webSearch && webSearchSupport(instance.kind) === 'available',
      };
}

/** The scrubbed environment for this instance's CLI, for detection and for runs alike. */
export function childEnvFor(
  context: CliContext,
  instance: ProviderInstance,
  extra: Record<string, string> = {},
): Record<string, string> {
  return buildChildEnv(context.env, {
    keepApiKeys: cliSwitches(instance).useEnvApiKey,
    platform: context.platform,
    extra,
  });
}

const MODEL_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
const EFFORT_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Model and effort names end up in argv. They are identifiers, so anything
 * that could be read as an option or carries free text is refused.
 */
export const isModelArgument = (value: string): boolean => MODEL_ARGUMENT.test(value);
export const isEffortArgument = (value: string): boolean => EFFORT_ARGUMENT.test(value);

/** The first dotted version number in a `--version` output. */
export function extractVersion(text: string): string | undefined {
  return /\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?/.exec(text)?.[0].slice(0, 64);
}

export type VersionProbe =
  { available: true; version?: string } | { available: false; detection: ProviderDetection };

/** Runs the version command; when the CLI is not usable, returns the detection saying why. */
export async function probeVersion(
  context: CliContext,
  executable: string,
  args: string[],
  env: Record<string, string>,
  streaming: StreamingMode,
): Promise<VersionProbe> {
  const result = await captureCli(executable, args, env, context);
  const unusable = (installed: boolean, hint: string): VersionProbe => ({
    available: false,
    detection: { installed, loggedIn: 'unknown', streaming, hint },
  });
  switch (result.outcome) {
    case 'not_found':
      return unusable(false, `\`${executable}\` was not found on PATH.`);
    case 'spawn_failed':
      return unusable(true, `\`${executable}\` was found on PATH but could not be started.`);
    case 'timeout':
      return unusable(true, `\`${executable}\` did not answer in time.`);
    case 'aborted':
      return unusable(true, 'Detection was interrupted.');
    case 'exited': {
      const version = extractVersion(`${result.stdout}\n${result.stderr}`);
      return { available: true, ...(version === undefined ? {} : { version }) };
    }
  }
}

/** Everything a status command printed, for matching; never shown or stored. */
export function printed(result: CaptureResult): string {
  return result.outcome === 'exited' ? `${result.stdout}\n${result.stderr}` : '';
}

export interface BillingReport {
  billing: BillingSource;
  hint?: string;
}

/**
 * The billing source in effect. Without kept API-key variables the CLI's own
 * login decides, and the ignored variables are named. With kept variables the
 * CLI's status command, which ran with them, still decides when it reports
 * its own subscription login; only otherwise is the kept key taken as the
 * source.
 */
export function billingReport(
  context: CliContext,
  instance: ProviderInstance,
  relevant: (name: string) => boolean,
  fromLogin: BillingSource,
): BillingReport {
  const names = presentBillingVariables(context.env, context.platform, relevant);
  if (names.length === 0) return { billing: fromLogin };
  const list = names.join(', ');
  if (!cliSwitches(instance).useEnvApiKey) {
    return {
      billing: fromLogin,
      hint: `Not passed to the CLI: ${list}. Turn on "Use the API key from the server environment" to bill those instead of the CLI's own login.`,
    };
  }
  const passed = `Passed to the CLI from the environment: ${list}.`;
  return fromLogin === 'subscription'
    ? {
        billing: 'subscription',
        hint: `${passed} The CLI still reports its own login as the one in use.`,
      }
    : { billing: 'api-key', hint: passed };
}

/** Joins the parts that exist into one hint within the protocol's length limit. */
export function joinHints(...parts: (string | undefined)[]): { hint?: string } {
  const hint = parts.filter((part) => part !== undefined && part !== '').join(' ');
  return hint === '' ? {} : { hint: hint.slice(0, 500) };
}

/** A non-negative integer token count, or `undefined` for anything else. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * `start` followed by the error for a model or effort name that cannot be
 * passed as an argument; `undefined` when the selection is fine.
 */
export function rejectedSelection(
  request: Pick<RunRequest, 'model' | 'effort'>,
  streaming: StreamingMode,
): ProviderEvent[] | undefined {
  const reject = (code: 'model_not_found' | 'unsupported', message: string): ProviderEvent[] => [
    { type: 'start', streaming },
    { type: 'error', code, message },
  ];
  if (request.model !== undefined && !isModelArgument(request.model)) {
    return reject('model_not_found', 'The model name contains characters a model id cannot have.');
  }
  if (request.effort !== undefined && !isEffortArgument(request.effort)) {
    return reject(
      'unsupported',
      'The effort name contains characters an effort level cannot have.',
    );
  }
  return undefined;
}
