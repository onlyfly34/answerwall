import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  API_VERSION,
  BRAND,
  createDefaultSettings,
  DESKTOP_BRIDGE_GLOBAL,
  SettingsPatchSchema,
} from '@answerwall/core/protocol';
import type {
  Meta,
  OpenAiCompatInstance,
  ProviderInstanceInput,
  ProviderStatus,
  Settings,
} from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import { createFakeServices, readyProviderStatus } from '../../contracts/testing.ts';
import type { FakeServices } from '../../contracts/testing.ts';
import { renderPage, setValue } from '../test-support.tsx';
import { AGY_FAQ_QUOTE, AGY_FAQ_URL } from './AcknowledgeDialog.tsx';
import { ProvidersPage } from './ProvidersPage.tsx';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(window, DESKTOP_BRIDGE_GLOBAL);
});

const endpoint: OpenAiCompatInstance = {
  id: 'home-llm',
  kind: 'openai-compat',
  label: 'Home LLM',
  enabled: true,
  concurrency: 4,
  models: ['small'],
  baseUrl: 'http://127.0.0.1:8080',
  hasApiKey: true,
};

function settingsWith(...extra: OpenAiCompatInstance[]): Settings {
  const settings = createDefaultSettings();
  return { ...settings, providers: [...settings.providers, ...extra] };
}

function setup(options: { settings?: Settings; providers?: ProviderStatus[]; meta?: Meta } = {}) {
  const services = createFakeServices({
    ...(options.meta ? { meta: options.meta } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  });
  renderPage(() => <ProvidersPage />, services);
  return services;
}

const card = (label: string) => within(screen.getByRole('region', { name: label }));

/** The provider list of the most recent save, checked against what the server accepts. */
function savedProviders(services: FakeServices): ProviderInstanceInput[] {
  const patch = services.settingsUpdates.at(-1);
  expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  expect(Object.keys(patch ?? {})).toEqual(['providers']);
  return patch?.providers ?? [];
}

const saved = (services: FakeServices, id: string) =>
  savedProviders(services).find((provider) => provider.id === id);

describe('what was detected', () => {
  test('each provider shows install state, login state, billing source and streaming mode', () => {
    const settings = createDefaultSettings();
    const [claude, codex, agy, grok] = settings.providers.map(readyProviderStatus);
    setup({
      settings,
      providers: [
        {
          ...claude!,
          detection: {
            installed: true,
            version: '2.1.0',
            loggedIn: 'yes',
            billing: 'subscription',
            streaming: 'token',
          },
          detectedAt: Date.UTC(2026, 0, 2, 3, 4),
        },
        {
          ...codex!,
          detection: {
            installed: true,
            loggedIn: 'no',
            billing: 'api-key',
            streaming: 'block',
            hint: 'Run the login command below.',
          },
        },
        { ...agy!, detection: { installed: false, loggedIn: 'unknown', streaming: 'unknown' } },
        { ...grok!, detection: null, detectedAt: null },
      ],
    });

    const claudeCard = card('Claude');
    expect(claudeCard.getByText('Installed').nextElementSibling?.textContent).toContain('Yes');
    expect(claudeCard.getByText('version 2.1.0', { exact: false })).toBeDefined();
    expect(claudeCard.getByText('Logged in').nextElementSibling?.textContent).toBe('Yes');
    expect(claudeCard.getByText('Billing source').nextElementSibling?.textContent).toBe(
      'Subscription login',
    );
    expect(claudeCard.getByText('Streaming').nextElementSibling?.textContent).toBe(
      'Token by token',
    );
    expect(claudeCard.getByText('Last checked')).toBeDefined();

    const codexCard = card('Codex');
    expect(codexCard.getByText('Logged in').nextElementSibling?.textContent).toBe('No');
    expect(codexCard.getByText('Billing source').nextElementSibling?.textContent).toBe('API key');
    expect(codexCard.getByText('Streaming').nextElementSibling?.textContent).toBe(
      'Whole messages (this provider does not stream token by token)',
    );
    expect(codexCard.getByText('Run the login command below.')).toBeDefined();

    const agyCard = card('Gemini (agy)');
    expect(agyCard.getByText('Installed').nextElementSibling?.textContent).toBe('No');
    expect(agyCard.getByText('Billing source').nextElementSibling?.textContent).toBe('Unknown');

    expect(card('Grok').getByText('Not checked yet. Press Refresh.')).toBeDefined();
  });

  test('a provider the server is detecting right now says so instead of asking for a refresh', () => {
    const settings = createDefaultSettings();
    const [claude, ...others] = settings.providers.map(readyProviderStatus);
    setup({
      settings,
      providers: [{ ...claude!, detection: null, detectedAt: null, detecting: true }, ...others],
    });

    expect(card('Claude').getByText('Checking…')).toBeDefined();
    expect(card('Claude').queryByText('Not checked yet. Press Refresh.')).toBeNull();
  });

  test.each([
    ['none', 'this provider has no tools.'],
    ['disabled', 'tools are switched off for every question.'],
    ['read-only', 'this tool cannot switch its tools off'],
    ['unrestricted', 'no documented way to switch off or restrict its tools'],
  ] as const)('the tool-access note for "%s" says what the provider can do', (toolAccess, text) => {
    const settings = createDefaultSettings();
    setup({
      settings,
      providers: settings.providers.map((instance) => ({
        ...readyProviderStatus(instance),
        toolAccess: instance.id === 'grok' ? toolAccess : 'disabled',
      })),
    });

    expect(card('Grok').getByText(text, { exact: false })).toBeDefined();
  });

  test('the exact login command is shown and can be copied', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const settings = createDefaultSettings();
    const services = setup({
      settings,
      providers: settings.providers.map((instance) => ({
        ...readyProviderStatus(instance),
        ...(instance.id === 'codex' ? { loginCommand: 'codex login' } : {}),
      })),
    });

    expect(card('Codex').getByText('codex login').tagName).toBe('CODE');
    expect(card('Claude').queryByRole('button', { name: 'Copy the login command' })).toBeNull();

    fireEvent.click(card('Codex').getByRole('button', { name: 'Copy the login command' }));

    await waitFor(() => expect(services.toasts).toEqual([{ kind: 'success', message: 'Copied.' }]));
    expect(writeText).toHaveBeenCalledWith('codex login');
  });

  describe('the desktop app', () => {
    const desktopMeta: Meta = {
      name: BRAND.name,
      version: '0.0.0-test',
      apiVersion: API_VERSION,
      mode: 'desktop',
      tls: 'off',
      authRequired: true,
    };
    const withLoginCommands = (settings: Settings): ProviderStatus[] =>
      settings.providers.map((instance) => ({
        ...readyProviderStatus(instance),
        ...(instance.kind === 'openai-compat' ? {} : { loginCommand: `${instance.id} login` }),
      }));
    const installBridge = (answer: unknown) => {
      const openLoginTerminal = vi.fn(async () => answer);
      Object.defineProperty(window, DESKTOP_BRIDGE_GLOBAL, {
        value: { openLoginTerminal },
        configurable: true,
      });
      return openLoginTerminal;
    };
    const OPEN = 'Open a terminal to log in to Codex';

    test('offers to open a terminal, naming the provider kind and never a command', async () => {
      const openLoginTerminal = installBridge({ ok: true });
      const settings = settingsWith(endpoint);
      const services = setup({
        settings,
        providers: withLoginCommands(settings),
        meta: desktopMeta,
      });

      expect(card('Home LLM').queryByRole('button', { name: /Open a terminal/ })).toBeNull();
      fireEvent.click(card('Codex').getByRole('button', { name: OPEN }));

      await waitFor(() =>
        expect(services.toasts).toEqual([
          {
            kind: 'info',
            message: 'A terminal window was opened. Log in there, then press Refresh.',
          },
        ]),
      );
      expect(openLoginTerminal.mock.calls).toEqual([['codex']]);
      // Logging in is the user's act; nothing is detected again on its own.
      expect(services.refreshes).toEqual([]);
    });

    test('says so when no terminal could be opened, or the shell answers something else', async () => {
      installBridge({ ok: false, reason: 'no_terminal' });
      const settings = createDefaultSettings();
      const services = setup({
        settings,
        providers: withLoginCommands(settings),
        meta: desktopMeta,
      });

      fireEvent.click(card('Codex').getByRole('button', { name: OPEN }));
      await waitFor(() => expect(services.toasts).toHaveLength(1));

      installBridge('opened');
      fireEvent.click(card('Codex').getByRole('button', { name: OPEN }));
      await waitFor(() => expect(services.toasts).toHaveLength(2));

      expect(services.toasts.map((toast) => toast.kind)).toEqual(['error', 'error']);
    });

    test('the button is absent in a browser, with or without something of that name on the page', () => {
      const settings = createDefaultSettings();
      installBridge({ ok: true });
      setup({ settings, providers: withLoginCommands(settings) });

      expect(screen.queryByRole('button', { name: /Open a terminal/ })).toBeNull();
    });

    test('the button is absent in desktop mode without the bridge', () => {
      const settings = createDefaultSettings();
      setup({ settings, providers: withLoginCommands(settings), meta: desktopMeta });

      expect(screen.queryByRole('button', { name: /Open a terminal/ })).toBeNull();
      expect(card('Codex').getByText(/in a terminal on this computer/)).toBeDefined();
    });
  });

  test('where the clipboard is unavailable the copy button says so', async () => {
    const settings = createDefaultSettings();
    const services = setup({
      settings,
      providers: settings.providers.map((instance) => ({
        ...readyProviderStatus(instance),
        loginCommand: `${instance.id} login`,
      })),
    });

    fireEvent.click(card('Grok').getByRole('button', { name: 'Copy the login command' }));

    await waitFor(() => expect(services.toasts[0]?.kind).toBe('error'));
  });
});

describe('refresh', () => {
  test('detection runs only when a refresh button is pressed: all, or one provider', () => {
    const services = setup();
    expect(services.refreshes).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Codex' }));

    expect(services.refreshes).toEqual([undefined, 'codex']);
  });

  test('a failed refresh is reported', async () => {
    const services = createFakeServices();
    const failure = new ApiError('internal', 500, 'oops');
    renderPage(() => <ProvidersPage />, {
      ...services,
      providers: { ...services.providers, refresh: () => Promise.reject(failure) },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all' }));

    await waitFor(() => expect(services.errors).toEqual([failure]));
  });
});

describe('enabling and disabling', () => {
  test('disabling a provider saves the whole list with just that change', async () => {
    const services = setup();
    const box = card('Claude').getByRole<HTMLInputElement>('checkbox', { name: 'Enabled' });
    expect(box.checked).toBe(true);

    fireEvent.click(box);

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    expect(savedProviders(services).map((provider) => [provider.id, provider.enabled])).toEqual([
      ['claude', false],
      ['codex', true],
      ['agy', false],
      ['grok', true],
    ]);
    await waitFor(() => expect(box.checked).toBe(false));
  });

  test('enabling agy first shows the vendor notice; cancelling leaves it disabled', () => {
    const services = setup();
    const box = card('Gemini (agy)').getByRole<HTMLInputElement>('checkbox', { name: 'Enabled' });

    fireEvent.click(box);

    const dialog = within(screen.getByRole('dialog', { name: 'Before you enable Gemini (agy)' }));
    expect(
      dialog.getByText('third-party wrappers are not supported under consumer plans', {
        exact: false,
      }),
    ).toBeDefined();
    const quote = dialog.getByText(AGY_FAQ_QUOTE);
    expect(quote.tagName).toBe('BLOCKQUOTE');
    expect(quote.textContent).toContain('is not supported under consumer plans');
    const source = dialog.getByRole<HTMLAnchorElement>('link', { name: AGY_FAQ_URL });
    expect(source.rel).toBe('noopener noreferrer');
    expect(source.target).toBe('_blank');
    expect(box.checked).toBe(false);

    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(services.settingsUpdates).toEqual([]);
    expect(box.checked).toBe(false);
  });

  test('agy is enabled only after the risk is explicitly accepted', async () => {
    const services = setup();
    fireEvent.click(card('Gemini (agy)').getByRole('checkbox', { name: 'Enabled' }));
    const dialog = within(screen.getByRole('dialog'));
    const confirm = dialog.getByRole<HTMLButtonElement>('button', { name: 'Enable anyway' });
    expect(confirm.disabled).toBe(true);

    fireEvent.click(
      dialog.getByRole('checkbox', { name: 'I have read this and accept the risk.' }),
    );
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    expect(saved(services, 'agy')).toMatchObject({ enabled: true, riskAcknowledged: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('once acknowledged, agy is switched on and off without the dialog', async () => {
    const settings = createDefaultSettings();
    const services = setup({
      settings: {
        ...settings,
        providers: settings.providers.map((provider) =>
          provider.kind === 'agy' ? { ...provider, riskAcknowledged: true } : provider,
        ),
      },
    });

    fireEvent.click(card('Gemini (agy)').getByRole('checkbox', { name: 'Enabled' }));

    await waitFor(() => expect(saved(services, 'agy')).toMatchObject({ enabled: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('the dialog holds the focus and closes on Escape, returning focus to the switch', () => {
    setup();
    const box = card('Gemini (agy)').getByRole<HTMLInputElement>('checkbox', { name: 'Enabled' });
    box.focus();
    fireEvent.click(box);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    const controls = [
      ...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input'),
    ];
    controls.at(-1)?.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(controls.at(-1));

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  test('a refused save is reported and the switch shows the stored value again', async () => {
    const services = createFakeServices();
    const refusal = new ApiError('bad_request', 400, 'providers: refused');
    renderPage(() => <ProvidersPage />, {
      ...services,
      settings: { ...services.settings, update: () => Promise.reject(refusal) },
    });

    fireEvent.click(card('Claude').getByRole('checkbox', { name: 'Enabled' }));

    await waitFor(() => expect(services.errors).toEqual([refusal]));
    expect(
      card('Claude').getByRole<HTMLInputElement>('checkbox', { name: 'Enabled' }).checked,
    ).toBe(true);
  });
});

describe('provider settings', () => {
  test('concurrency is saved within the bounds of the kind and refused outside them', async () => {
    const services = setup();
    const input = card('Claude').getByLabelText<HTMLInputElement>('Parallel requests');
    expect(input.value).toBe('2');
    expect(input.min).toBe('1');
    expect(input.max).toBe('5');

    for (const bad of ['0', '6', '2.5', '']) {
      setValue(input, bad);
      expect(input.getAttribute('aria-invalid'), bad).toBe('true');
    }
    expect(services.settingsUpdates).toEqual([]);

    setValue(input, '5');
    await waitFor(() => expect(saved(services, 'claude')).toMatchObject({ concurrency: 5 }));
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  test('agy concurrency is fixed at one', () => {
    setup();
    const input = card('Gemini (agy)').getByLabelText<HTMLInputElement>('Parallel requests');

    expect(input.disabled).toBe(true);
    expect(input.value).toBe('1');
    expect(card('Gemini (agy)').getByText('Fixed at 1 for this provider.')).toBeDefined();
  });

  test('keeping the environment API key is a per-provider switch that states its billing effect', async () => {
    const services = setup();
    const box = card('Codex').getByRole('checkbox', {
      name: 'Use the API key from the server environment',
    });
    expect(
      card('Codex').getByText('usage is billed to that API key', { exact: false }),
    ).toBeDefined();

    fireEvent.click(box);

    await waitFor(() => expect(saved(services, 'codex')).toMatchObject({ useEnvApiKey: true }));
    expect(saved(services, 'claude')).toMatchObject({ useEnvApiKey: false });
  });

  test('web search is a per-provider switch on the tools where it was confirmed', async () => {
    const services = setup();
    for (const label of ['Claude', 'Codex']) {
      expect(
        card(label).getByRole<HTMLInputElement>('checkbox', { name: 'Allow web search' }).checked,
      ).toBe(false);
    }
    expect(
      card('Codex').getByText('every other tool stays as restricted as before', { exact: false }),
    ).toBeDefined();

    fireEvent.click(card('Codex').getByRole('checkbox', { name: 'Allow web search' }));

    await waitFor(() => expect(saved(services, 'codex')).toMatchObject({ webSearch: true }));
    expect(saved(services, 'claude')).toMatchObject({ webSearch: false });
  });

  test('a tool whose web search was not confirmed has no switch and says so', () => {
    setup({ settings: settingsWith(endpoint) });

    for (const label of ['Gemini (agy)', 'Grok']) {
      expect(card(label).queryByRole('checkbox', { name: 'Allow web search' })).toBeNull();
      expect(card(label).getByText('Web search: not available.', { exact: false })).toBeDefined();
    }
    expect(card('Home LLM').queryByRole('checkbox', { name: 'Allow web search' })).toBeNull();
    expect(card('Home LLM').queryByText('Web search', { exact: false })).toBeNull();
    expect(card('Claude').queryByText('Web search: not available.', { exact: false })).toBeNull();
  });

  test('models can be added, removed and chosen as the default', async () => {
    const services = setup();
    const claude = card('Claude');
    expect(
      claude.getAllByRole('listitem').map((item) => item.querySelector('code')?.textContent),
    ).toEqual(['fable', 'opus', 'sonnet', 'haiku']);

    setValue(claude.getByLabelText('Add a model'), '  claude-next-1  ');
    fireEvent.click(claude.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(saved(services, 'claude')?.models).toEqual([
        'fable',
        'opus',
        'sonnet',
        'haiku',
        'claude-next-1',
      ]),
    );
    await waitFor(() =>
      expect(claude.getByLabelText<HTMLInputElement>('Add a model').value).toBe(''),
    );

    setValue(claude.getByLabelText('Default model'), 'opus');
    await waitFor(() => expect(saved(services, 'claude')?.defaultModel).toBe('opus'));

    // Removing the default model clears the default as well.
    fireEvent.click(claude.getByRole('button', { name: 'Remove opus' }));
    await waitFor(() => expect(saved(services, 'claude')?.models).not.toContain('opus'));
    expect(saved(services, 'claude')).not.toHaveProperty('defaultModel');
  });

  test('an empty model name is refused', () => {
    const services = setup();
    const claude = card('Claude');

    setValue(claude.getByLabelText('Add a model'), '   ');
    fireEvent.click(claude.getByRole('button', { name: 'Add' }));

    expect(claude.getByText('Enter a model name', { exact: false })).toBeDefined();
    expect(services.settingsUpdates).toEqual([]);
  });

  test('models the provider lists itself can be the default without being added', async () => {
    const settings = createDefaultSettings();
    const services = setup({
      settings,
      providers: settings.providers.map((instance) => ({
        ...readyProviderStatus(instance),
        ...(instance.id === 'codex' ? { models: [{ id: 'listed-by-cli' }] } : {}),
      })),
    });

    setValue(card('Codex').getByLabelText('Default model'), 'listed-by-cli');

    await waitFor(() =>
      expect(saved(services, 'codex')).toMatchObject({ models: [], defaultModel: 'listed-by-cli' }),
    );
  });
});

describe('OpenAI-compatible endpoints', () => {
  const dialog = () => within(screen.getByRole('dialog'));

  test('CLI providers cannot be edited as endpoints or removed', () => {
    setup();
    expect(screen.getByText('No endpoints yet.')).toBeDefined();
    expect(card('Claude').queryByRole('button', { name: 'Remove Claude' })).toBeNull();
    expect(card('Claude').queryByRole('button', { name: 'Edit Claude' })).toBeNull();
  });

  test('adding an endpoint sends its key once and never shows it again', async () => {
    const services = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));

    setValue(dialog().getByLabelText('Name'), 'My LiteLLM (home)');
    expect(dialog().getByLabelText<HTMLInputElement>('Identifier').value).toBe('my-litellm-home');
    setValue(dialog().getByLabelText('Base URL'), 'https://llm.example/v1');
    const key = dialog().getByLabelText<HTMLInputElement>('API key');
    expect(key.type).toBe('password');
    setValue(key, 'sk-secret-value');
    setValue(dialog().getByLabelText('Parallel requests'), '8');
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved(services, 'my-litellm-home')).toEqual({
      kind: 'openai-compat',
      id: 'my-litellm-home',
      label: 'My LiteLLM (home)',
      enabled: true,
      concurrency: 8,
      models: [],
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-secret-value',
    });
    expect(savedProviders(services)).toHaveLength(5);
    expect(services.toasts).toContainEqual({ kind: 'success', message: 'Saved.' });

    const added = card('My LiteLLM (home)');
    expect(added.getByText('Stored (hidden)')).toBeDefined();
    expect(added.getByText('https://llm.example/v1')).toBeDefined();
    expect(document.body.innerHTML).not.toContain('sk-secret-value');
  });

  test('invalid fields are flagged and nothing is saved', () => {
    const services = setup({ settings: settingsWith(endpoint) });
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));

    setValue(dialog().getByLabelText('Name'), 'Home LLM');
    // The suggested identifier is already taken by the existing endpoint.
    expect(dialog().getByLabelText<HTMLInputElement>('Identifier').value).toBe('home-llm');
    setValue(dialog().getByLabelText('Base URL'), 'ftp://files.example');
    setValue(dialog().getByLabelText('Parallel requests'), '33');
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));

    expect(dialog().getByText('an identifier that is not taken', { exact: false })).toBeDefined();
    expect(dialog().getByText('Enter an http:// or https:// address.')).toBeDefined();
    expect(dialog().getByText('Enter a whole number from 1 to 32.')).toBeDefined();
    expect(document.activeElement).toBe(dialog().getByLabelText('Identifier'));
    expect(services.settingsUpdates).toEqual([]);

    setValue(dialog().getByLabelText('Identifier'), 'claude');
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));
    expect(dialog().getByLabelText('Identifier').getAttribute('aria-invalid')).toBe('true');
    expect(services.settingsUpdates).toEqual([]);
  });

  test('editing keeps the stored key unless a new one is typed', async () => {
    const services = setup({ settings: settingsWith(endpoint) });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Home LLM' }));

    expect(dialog().getByLabelText<HTMLInputElement>('Identifier').readOnly).toBe(true);
    expect(dialog().getByLabelText<HTMLInputElement>('API key').value).toBe('');
    setValue(dialog().getByLabelText('Name'), 'Home LLM 2');
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    const patch = saved(services, 'home-llm');
    expect(patch).toMatchObject({ id: 'home-llm', label: 'Home LLM 2', models: ['small'] });
    expect(patch).not.toHaveProperty('apiKey');
    expect(patch).not.toHaveProperty('hasApiKey');
  });

  test('editing can replace the key or delete it', async () => {
    const services = setup({ settings: settingsWith(endpoint) });

    fireEvent.click(screen.getByRole('button', { name: 'Edit Home LLM' }));
    setValue(dialog().getByLabelText('API key'), 'sk-new');
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved(services, 'home-llm')).toMatchObject({ apiKey: 'sk-new' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Edit Home LLM' }));
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Delete the stored key' }));
    expect(dialog().getByLabelText<HTMLInputElement>('API key').disabled).toBe(true);
    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved(services, 'home-llm')).toMatchObject({ apiKey: null }));
    await waitFor(() => expect(card('Home LLM').getByText('None')).toBeDefined());
  });

  test('changing another provider never sends or drops an endpoint key', async () => {
    const services = setup({ settings: settingsWith(endpoint) });

    fireEvent.click(card('Grok').getByRole('checkbox', { name: 'Enabled' }));

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    expect(saved(services, 'home-llm')).not.toHaveProperty('apiKey');
    expect(services.settings.settings()?.providers.at(-1)).toMatchObject({ hasApiKey: true });
  });

  test('removing an endpoint asks first, then saves the list without it', async () => {
    const services = setup({ settings: settingsWith(endpoint) });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Home LLM' }));

    const confirm = within(screen.getByRole('dialog', { name: 'Remove Home LLM?' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(services.settingsUpdates).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Home LLM' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    expect(savedProviders(services).map((provider) => provider.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
    ]);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Home LLM' })).toBeNull());
    expect(services.toasts).toContainEqual({ kind: 'success', message: 'Home LLM was removed.' });
  });

  test('a refused endpoint keeps the dialog open with what was typed', async () => {
    const services = createFakeServices();
    const refusal = new ApiError('bad_request', 400, 'providers.4.baseUrl: refused');
    renderPage(() => <ProvidersPage />, {
      ...services,
      settings: { ...services.settings, update: () => Promise.reject(refusal) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    setValue(dialog().getByLabelText('Name'), 'Lab');
    setValue(dialog().getByLabelText('Base URL'), 'http://lab.example');

    fireEvent.click(dialog().getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(services.errors).toEqual([refusal]));
    expect(dialog().getByLabelText<HTMLInputElement>('Name').value).toBe('Lab');
  });
});
