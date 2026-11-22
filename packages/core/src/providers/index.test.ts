import { afterEach, describe, expect, test } from 'vitest';
import {
  CLI_PROVIDER_KINDS,
  createDefaultSettings,
  LOGIN_COMMANDS,
  PROVIDER_KINDS,
} from '../protocol/index.ts';
import { systemClock } from '../system.ts';
import { createFakeSecretStore, createFakeSettingsService } from '../testing/index.ts';
import { createProviderRegistry } from './index.ts';
import { answerOf, collect, createMockCliHarness } from './test-harness.ts';
import type { MockCliHarness } from './test-harness.ts';

describe('createProviderRegistry', () => {
  let harness: MockCliHarness;
  afterEach(() => harness.cleanup());

  const build = () =>
    createProviderRegistry({
      settings: createFakeSettingsService(createDefaultSettings()),
      secrets: createFakeSecretStore(),
      clock: systemClock,
      logger: harness.logger,
      env: harness.context.env,
    });

  test('has one adapter per provider kind', async () => {
    harness = await createMockCliHarness();
    const registry = build();

    expect(PROVIDER_KINDS.map((kind) => registry.adapter(kind).kind)).toEqual([...PROVIDER_KINDS]);
    await registry.shutdown();
  });

  test('every CLI adapter shows the login command of the shared table, which stays plain words', async () => {
    harness = await createMockCliHarness();
    const registry = build();

    for (const kind of CLI_PROVIDER_KINDS) {
      expect(registry.adapter(kind).loginCommand).toBe(LOGIN_COMMANDS[kind]);
      // The desktop shell hands the command to a terminal: the CLI's own name, then flags.
      expect(LOGIN_COMMANDS[kind]).toMatch(new RegExp(`^${kind}( [a-z-]+)*$`));
    }
    expect(Object.keys(LOGIN_COMMANDS).sort()).toEqual([...CLI_PROVIDER_KINDS].sort());
    expect(registry.adapter('openai-compat').loginCommand).toBeUndefined();
    await registry.shutdown();
  });

  test('detects the installed CLIs from the given environment and lists their models', async () => {
    harness = await createMockCliHarness();
    const registry = build();

    const list = await registry.refresh();

    const byId = Object.fromEntries(list.map((status) => [status.instance.id, status]));
    expect(byId.claude?.detection).toMatchObject({
      installed: true,
      loggedIn: 'yes',
      billing: 'subscription',
      streaming: 'token',
    });
    expect(byId.codex?.detection).toMatchObject({
      installed: true,
      loggedIn: 'yes',
      streaming: 'block',
    });
    expect(byId.codex?.models.map((model) => model.id)).toEqual([
      'mock-codex-large',
      'mock-codex-small',
    ]);
    expect(byId.grok?.detection).toMatchObject({ installed: true, loggedIn: 'unknown' });
    expect(byId.grok?.models.map((model) => model.id)).toEqual([
      'mock-grok-large',
      'mock-grok-fast',
    ]);
    // Off until its notice is acknowledged: the mock was never started.
    expect(byId.agy?.detection).toBeNull();
    expect((await harness.invocations()).some((call) => call.kind === 'agy')).toBe(false);
    await registry.shutdown();
  });

  test('its adapters answer through the CLIs on that PATH', async () => {
    harness = await createMockCliHarness();
    const registry = build();
    const instance = createDefaultSettings().providers.find(
      (provider) => provider.kind === 'codex',
    );
    if (!instance) throw new Error('no codex instance');

    const events = await collect(registry.adapter('codex').run(instance, await harness.request()));

    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    await registry.shutdown();
  });

  test('reports CLIs that are not installed without failing', async () => {
    harness = await createMockCliHarness({ env: { PATH: '' } });
    const registry = build();

    const list = await registry.refresh();

    expect(
      list.filter((status) => status.instance.enabled).map((status) => status.detection?.installed),
    ).toEqual([false, false, false]);
    await registry.shutdown();
  });

  test('shutdown stops detection: nothing is started afterwards', async () => {
    harness = await createMockCliHarness();
    const registry = build();

    await registry.shutdown();
    const list = await registry.refresh();

    expect(list.every((status) => status.detection === null)).toBe(true);
    expect(await harness.invocations()).toEqual([]);
  });
});
