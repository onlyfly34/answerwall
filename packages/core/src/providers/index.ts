import type {
  Clock,
  Logger,
  ProviderRegistry,
  SecretStore,
  SettingsService,
} from '../contracts/index.ts';
import { createAgyAdapter } from './agy.ts';
import { createClaudeAdapter } from './claude.ts';
import type { CliContext } from './cli/run-cli.ts';
import { createCodexAdapter } from './codex.ts';
import { createGrokAdapter } from './grok.ts';
import { createOpenAiCompatAdapter } from './openai-compat.ts';
import { createOpencodeAdapter } from './opencode.ts';
import { createRegistry } from './registry.ts';

export interface ProviderRegistryDeps {
  settings: SettingsService;
  /** API keys of OpenAI-compatible endpoints. */
  secrets: SecretStore;
  clock: Clock;
  logger: Logger;
  /** The environment child processes start from, before scrubbing. */
  env: NodeJS.ProcessEnv;
}

export function createProviderRegistry(deps: ProviderRegistryDeps): ProviderRegistry {
  const shutdown = new AbortController();
  const logger = deps.logger.child({ unit: 'providers' });
  const cli: CliContext = {
    env: deps.env,
    platform: process.platform,
    clock: deps.clock,
    logger,
    shutdownSignal: shutdown.signal,
  };
  // Adding a provider kind: one adapter file and one line here.
  const adapters = [
    createClaudeAdapter(cli),
    createCodexAdapter(cli),
    createAgyAdapter(cli),
    createGrokAdapter(cli),
    createOpencodeAdapter(cli),
    createOpenAiCompatAdapter({
      secrets: deps.secrets,
      clock: deps.clock,
      logger,
      shutdownSignal: shutdown.signal,
      env: deps.env,
    }),
  ];
  return createRegistry({ settings: deps.settings, clock: deps.clock, logger, adapters, shutdown });
}
