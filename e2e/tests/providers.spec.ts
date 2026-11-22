import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { STUB_API_KEY } from '../support/stub.ts';
import {
  answer,
  arrange,
  cell,
  cells,
  expectPhases,
  nav,
  send,
  sendButton,
  showCell,
} from '../support/wall.ts';

const card = (page: Page, label: string): Locator =>
  page.getByRole('region', { name: label, exact: true });

/** The value shown next to a label in a card's list of facts. */
const fact = (within: Locator, label: string): Locator =>
  within
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');

async function openProviders(page: Page): Promise<void> {
  await nav(page, 'Providers').click();
  await expect(page.getByRole('heading', { name: 'Providers', level: 1 })).toBeVisible();
}

test.describe('providers page', () => {
  test('shows what the server detected, without identifying details', async ({
    wallPage: page,
    server,
  }) => {
    await server.detected();
    await page.reload();
    await openProviders(page);

    const claude = card(page, 'Claude');
    await expect(fact(claude, 'Installed')).toHaveText('Yes version 2.1.330');
    await expect(fact(claude, 'Logged in')).toHaveText('Yes');
    await expect(fact(claude, 'Billing source')).toHaveText('Subscription login');
    await expect(fact(claude, 'Streaming')).toHaveText('Token by token');
    await expect(fact(claude, 'Last checked')).not.toBeEmpty();
    await expect(claude).toContainText('Tool access: tools are switched off for every question.');
    await expect(claude.locator('code.app-code')).toHaveText('claude auth login');
    await expect(claude.getByLabel('Enabled')).toBeChecked();
    await expect(claude.getByLabel('Parallel requests')).toHaveValue('2');

    const codex = card(page, 'Codex');
    await expect(fact(codex, 'Installed')).toHaveText('Yes version 0.167.0');
    await expect(fact(codex, 'Streaming')).toHaveText(
      'Whole messages (this provider does not stream token by token)',
    );
    await expect(codex.locator('code.app-code')).toHaveText('codex login');

    await expect(fact(card(page, 'Grok'), 'Installed')).toContainText('Yes');
    // Grok has no status subcommand, so its login state is not known before the first answer.
    await expect(fact(card(page, 'Grok'), 'Logged in')).toHaveText('Unknown');

    // Disabled by default, never checked, and marked with the vendor's caveat.
    const agy = card(page, 'Gemini (agy)');
    await expect(agy.getByLabel('Enabled')).not.toBeChecked();
    await expect(agy).toContainText('Not checked yet. Press Refresh.');
    await expect(agy).toContainText('third-party wrappers are not supported under consumer plans');
    await expect(agy.getByLabel('Parallel requests')).toBeDisabled();

    // Also off until the user enables it, and therefore not checked at the start.
    const opencode = card(page, 'OpenCode');
    await expect(opencode.getByLabel('Enabled')).not.toBeChecked();
    await expect(opencode).toContainText('Not checked yet. Press Refresh.');
    await expect(opencode.locator('code.app-code')).toHaveText('opencode auth login');
    expect(server.mockInvocations().some((entry) => entry.kind === 'opencode')).toBe(false);

    // The mocks report an account e-mail, an organisation and a config path; none reaches the page.
    const body = await page.locator('body').innerText();
    for (const secret of ['mock.user@example.com', 'Mock Organisation', 'org-mock', '/home/mock']) {
      expect(body).not.toContain(secret);
    }
    const api = JSON.stringify(await server.providers());
    for (const secret of ['mock.user@example.com', 'Mock Organisation', 'org-mock', '/home/mock']) {
      expect(api).not.toContain(secret);
    }
  });

  test('opencode, once enabled, is detected and answers without tools through its own agent', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await server.setProviders({ opencode: { enabled: true } });
    await page.reload();
    await openProviders(page);

    const opencode = card(page, 'OpenCode');
    await expect(fact(opencode, 'Installed')).toHaveText('Yes version 2.3.2');
    await expect(fact(opencode, 'Logged in')).toHaveText('Yes');
    await expect(fact(opencode, 'Billing source')).toHaveText('Unknown');
    await expect(fact(opencode, 'Streaming')).toHaveText(
      'Whole messages (this provider does not stream token by token)',
    );
    await expect(opencode).toContainText('Tool access: tools are switched off for every question.');
    await expect(opencode).toContainText('Web search: not available.');
    // The mock names an account in its status output; only the fact of a connection is kept.
    const body = await page.locator('body').innerText();
    for (const secret of ['jane.doe@example.com', 'MOCK_GATEWAY_KEY']) {
      expect(body).not.toContain(secret);
      expect(JSON.stringify(await server.providers())).not.toContain(secret);
    }

    await nav(page, 'Wall').click();
    await arrange(page, server, [
      { slotId: 'p1', providerId: 'opencode', model: 'mock/mock-echo' },
      { slotId: 'p2', providerId: 'opencode', model: 'mock/mock-tool-denied' },
    ]);
    await send(page, 'Why is the sky blue?');
    await expectPhases(page, { p1: 'done', p2: 'done' });

    const echoed = await showCell(page, device, 'p1');
    await expect(echoed.locator('.wall-markdown')).toHaveText('You said: Why is the sky blue?');
    const refused = await showCell(page, device, 'p2');
    await expect(refused.locator('.wall-markdown')).toHaveText('I cannot use tools here.');
    await expect(refused).toContainText('Tools are switched off, so the call was refused.');

    const runs = server
      .mockInvocations()
      .filter((entry) => entry.kind === 'opencode' && typeof entry.prompt === 'string');
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.argv?.join(' ')).not.toContain('sky');
      expect(run.argv).toEqual(expect.arrayContaining(['--standalone', '--agent', 'answerwall']));
    }
  });

  test('a CLI runs only when Refresh is pressed', async ({ wallPage: page, server }) => {
    await server.detected();
    const started = (): number => server.mockInvocations().length;
    const atStart = started();
    expect(atStart).toBeGreaterThan(0);

    // Looking at the pages starts nothing.
    await openProviders(page);
    await page.reload();
    await expect(card(page, 'Claude')).toBeVisible();
    await nav(page, 'Wall').click();
    await openProviders(page);
    expect(started()).toBe(atStart);

    await page.getByRole('button', { name: 'Refresh Claude' }).click();
    await expect.poll(started).toBeGreaterThan(atStart);
    await expect(page.getByRole('button', { name: 'Refresh all' })).toBeEnabled();
    const afterOne = server.mockInvocations().slice(atStart);
    expect(new Set(afterOne.map((entry) => entry.kind))).toEqual(new Set(['claude']));
    // A check is the version and the status subcommand, never a prompt.
    expect(afterOne.every((entry) => entry.prompt === undefined)).toBe(true);

    const beforeAll = started();
    await page.getByRole('button', { name: 'Refresh all' }).click();
    await expect(page.getByRole('button', { name: 'Refresh all' })).toBeEnabled();
    const afterAll = server.mockInvocations().slice(beforeAll);
    expect(new Set(afterAll.map((entry) => entry.kind))).toEqual(
      new Set(['claude', 'codex', 'grok']),
    );
    const settled = started();
    await page.waitForTimeout(300);
    expect(started()).toBe(settled);
  });

  test('settings of a provider are saved, and the wall follows them', async ({
    wallPage: page,
    server,
  }) => {
    await expect(sendButton(page)).toHaveText('Send to 3');
    await openProviders(page);

    // The box keeps the saved value until the save has landed, so this is a click, not `uncheck`.
    await card(page, 'Codex').getByLabel('Enabled').click();
    await expect(card(page, 'Codex').getByLabel('Enabled')).not.toBeChecked();
    await card(page, 'Claude').getByLabel('Parallel requests').fill('1');
    await card(page, 'Claude').getByLabel('Parallel requests').blur();
    await expect
      .poll(async () => {
        const list = await server.providers();
        const find = (id: string) => list.find((status) => status.instance.id === id)?.instance;
        return [find('codex')?.enabled, find('claude')?.concurrency];
      })
      .toEqual([false, 1]);

    // The wall still has the Codex cell, marks it and leaves it out of the next ask.
    await nav(page, 'Wall').click();
    // By class, not by role: on a phone the cell is hidden behind its tab until it is chosen.
    const codexCell = cells(page).filter({
      has: page.locator('.wall-cell-name', { hasText: 'Codex' }),
    });
    await expect(codexCell).toHaveCount(1);
    await expect(sendButton(page)).toHaveText('Send to 2');
    await expect(codexCell.locator('.wall-cell-issue')).toBeAttached();
    await expect(codexCell.locator('.wall-cell-issue')).toContainText(
      'This provider is disabled, so this cell is skipped.',
    );
  });

  test('web search is allowed per provider, and a search shows as a note in the cell', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await openProviders(page);

    // Only the tools whose search was confirmed to work alone have the switch.
    for (const label of ['Claude', 'Codex']) {
      await expect(card(page, label).getByLabel('Allow web search')).not.toBeChecked();
    }
    for (const label of ['Grok', 'Gemini (agy)', 'OpenCode']) {
      await expect(card(page, label).getByLabel('Allow web search')).toHaveCount(0);
      await expect(card(page, label)).toContainText('Web search: not available.');
    }

    await card(page, 'Codex').getByLabel('Allow web search').click();
    await expect(card(page, 'Codex').getByLabel('Allow web search')).toBeChecked();
    await card(page, 'Claude').getByLabel('Allow web search').click();
    await expect(card(page, 'Claude').getByLabel('Allow web search')).toBeChecked();
    await expect
      .poll(async () =>
        (await server.providers()).map((status) =>
          'webSearch' in status.instance ? status.instance.webSearch : null,
        ),
      )
      .toEqual([true, true, false, false, false]);

    await nav(page, 'Wall').click();
    await arrange(page, server, [
      { slotId: 'c1', providerId: 'claude' },
      { slotId: 'x1', providerId: 'codex' },
    ]);
    await send(page, 'Which release is current?');
    await expectPhases(page, { c1: 'done', x1: 'done' });

    await showCell(page, device, 'c1');
    await expect(cell(page, 'c1').locator('.wall-cell-notice')).toContainText('Searching the web:');
    await expect(answer(page, 'c1')).not.toBeEmpty();
    await showCell(page, device, 'x1');
    await expect(cell(page, 'x1').locator('.wall-cell-notice')).toHaveText(
      'The model searched the web.',
    );
    await expect(answer(page, 'x1')).not.toBeEmpty();
  });

  test('enabling Gemini (agy) needs the risk notice to be accepted first', async ({
    wallPage: page,
    server,
  }) => {
    await openProviders(page);
    const agy = card(page, 'Gemini (agy)');
    await agy.getByLabel('Enabled').click();

    const dialog = page.getByRole('dialog', { name: 'Before you enable Gemini (agy)' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('blockquote')).not.toBeEmpty();
    // The source is a plain link that opens elsewhere; the page itself never loads it.
    const source = dialog.getByRole('link');
    await expect(source).toHaveAttribute('href', /^https:\/\//);
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(dialog.getByRole('button', { name: 'Enable anyway' })).toBeDisabled();

    // Cancelling leaves the provider off.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(agy.getByLabel('Enabled')).not.toBeChecked();
    expect((await server.providers()).find((s) => s.instance.id === 'agy')?.instance.enabled).toBe(
      false,
    );

    await agy.getByLabel('Enabled').click();
    await dialog.getByLabel('I have read this and accept the risk.').check();
    await dialog.getByRole('button', { name: 'Enable anyway' }).click();
    await expect(agy.getByLabel('Enabled')).toBeChecked();

    await agy.getByRole('button', { name: 'Refresh Gemini (agy)' }).click();
    await expect(fact(agy, 'Installed')).toContainText('Yes');
    await expect(agy.getByLabel('Parallel requests')).toHaveValue('1');
    await expect(agy).toContainText('Fixed at 1 for this provider.');
  });

  test('an OpenAI-compatible endpoint is added, used and removed; its key is never shown', async ({
    wallPage: page,
    server,
    stub,
    device,
  }) => {
    stub.script('stub-model', { chunks: ['Answer ', 'from ', 'the ', 'endpoint.'] });
    await openProviders(page);
    await expect(page.getByText('No endpoints yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Add endpoint' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add an endpoint' });
    await dialog.getByLabel('Name').fill('Local stub');
    await dialog.getByLabel('Identifier').fill('local-stub');
    await dialog.getByLabel('Base URL').fill('not a url');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Enter an http:// or https:// address.')).toBeVisible();
    await dialog.getByLabel('Base URL').fill(stub.url);
    await dialog.getByLabel('API key', { exact: true }).fill(STUB_API_KEY);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const endpoint = card(page, 'Local stub');
    await expect(endpoint).toBeVisible();
    await expect(fact(endpoint, 'Base URL')).toHaveText(stub.url);
    await expect(fact(endpoint, 'API key')).toHaveText('Stored (hidden)');
    await endpoint.getByRole('button', { name: 'Refresh Local stub' }).click();
    await expect(fact(endpoint, 'Reachable')).toContainText('Yes');

    // The key is write-only: not in the page, not in what the API returns.
    expect(await page.content()).not.toContain(STUB_API_KEY);
    const settings = await server.api('GET', '/api/settings');
    expect(JSON.stringify(settings.json)).not.toContain(STUB_API_KEY);
    expect(JSON.stringify(await server.providers())).not.toContain(STUB_API_KEY);

    // It answers on the wall like any other provider.
    await nav(page, 'Wall').click();
    await page.getByRole('button', { name: 'Add cell' }).click();
    const added = cells(page).last();
    if (device === 'phone') await page.getByRole('tab').last().click();
    await added.getByLabel('Provider').selectOption('local-stub');
    await added.getByLabel('Model').selectOption('stub-model');
    await send(page, 'Hello endpoint');
    await expect(added).toHaveAttribute('data-phase', 'done');
    await expect(added.locator('.wall-markdown')).toHaveText('Answer from the endpoint.');
    await expect(added.getByTestId('usage')).toHaveText('7 in · 4 out');

    // Removing it asks first.
    await openProviders(page);
    await card(page, 'Local stub').getByRole('button', { name: 'Remove Local stub' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove Local stub?' });
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Local stub was removed.')).toBeVisible();
    await expect(card(page, 'Local stub')).toHaveCount(0);
    await expect(page.getByText('No endpoints yet.')).toBeVisible();
  });
});

test.describe('with a CLI that is not installed', () => {
  test.use({ serverOptions: { mocks: 'without-grok', mockDelayMs: 120, env: {} } });

  test('the provider is shown as missing, and its cell says so', async ({
    wallPage: page,
    server,
    device,
  }) => {
    await server.detected();
    await page.reload();
    await openProviders(page);
    await expect(fact(card(page, 'Grok'), 'Installed')).toHaveText('No');
    await expect(fact(card(page, 'Claude'), 'Installed')).toContainText('Yes');

    await nav(page, 'Wall').click();
    const grok = cells(page).filter({ has: page.locator('.wall-cell-name', { hasText: 'Grok' }) });
    if (device === 'phone') await page.getByRole('tab', { name: 'Grok' }).click();
    await expect(grok.locator('.wall-cell-issue')).toContainText(
      'This provider was not found on the server.',
    );

    await send(page, 'Is Grok there?');
    await expect(grok).toHaveAttribute('data-phase', 'error');
    await expect(grok.getByRole('alert').locator('strong')).toHaveText(
      'The provider is not installed.',
    );
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(2);
  });
});

test.describe('with every CLI logged out', () => {
  test.use({
    serverOptions: { mocks: 'all', mockDelayMs: 120, env: { MOCK_CLI_SCENARIO: 'logged-out' } },
  });

  test('the providers page says so and shows how to log in', async ({ wallPage: page, server }) => {
    await server.detected();
    await page.reload();
    await openProviders(page);
    for (const [label, command] of [
      ['Claude', 'claude auth login'],
      ['Codex', 'codex login'],
    ] as const) {
      await expect(fact(card(page, label), 'Installed')).toContainText('Yes');
      await expect(fact(card(page, label), 'Logged in')).toHaveText('No');
      await expect(card(page, label).locator('code.app-code')).toHaveText(command);
      await expect(card(page, label)).toContainText(
        'Run this official command in a terminal on the server',
      );
    }
  });
});
