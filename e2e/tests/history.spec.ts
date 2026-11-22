import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import {
  answer,
  cancelAllButton,
  cells,
  expectPhase,
  nav,
  prompt,
  sendButton,
  showCell,
} from '../support/wall.ts';

const items = (page: Page): Locator => page.locator('.wall-history-item');
const item = (page: Page, text: string): Locator => items(page).filter({ hasText: text });
const search = (page: Page): Locator => page.getByRole('search').getByRole('searchbox');
const state = (page: Page): Locator => page.locator('.wall-history-state');

async function openHistory(page: Page): Promise<void> {
  await nav(page, 'History').click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
}

test.describe('history', () => {
  test('past asks are listed, searched, opened, asked again and deleted', async ({
    wallPage: page,
    server,
    device,
    guard,
  }) => {
    // The deleted ask is looked up once more at the end, on purpose.
    guard.allowConsole(/status of 404/);

    await openHistory(page);
    await expect(state(page)).toHaveText('Nothing has been asked yet.');

    const alpha = await server.ask('Alpha question about zebras', [
      { slotId: 'a1', providerId: 'claude', model: 'mock-echo' },
      { slotId: 'a2', providerId: 'grok', model: 'mock-echo' },
    ]);
    await server.finished(alpha);
    const beta = await server.ask('Beta question', [{ slotId: 'b1', providerId: 'grok' }]);
    await server.finished(beta);
    const gamma = await server.ask('Gamma question', [
      { slotId: 'g1', providerId: 'codex', model: 'mock-quota' },
    ]);
    await server.finished(gamma);

    await page.reload();
    await expect(items(page)).toHaveCount(3);
    // Newest first.
    await expect(items(page).locator('.wall-history-prompt')).toHaveText([
      'Gamma question',
      'Beta question',
      'Alpha question about zebras',
    ]);
    const alphaRow = item(page, 'Alpha question');
    await expect(alphaRow.getByRole('listitem')).toHaveText([
      /Claude mock-echo\s+done/,
      /Grok mock-echo\s+done/,
    ]);
    await expect(item(page, 'Gamma').getByRole('listitem')).toHaveText(/Codex mock-quota\s+error/);
    await expect(alphaRow.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/);
    // The list carries no answers.
    await expect(page.locator('.wall-history-list')).not.toContainText('You said');

    // Search by prompt, as you type…
    await search(page).fill('ZEBRAS');
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Alpha question about zebras');
    // …by a word that only an answer contains…
    await search(page).fill('Hello from the mock');
    await search(page).press('Enter');
    await expect(items(page)).toHaveCount(1);
    await expect(items(page)).toContainText('Beta question');
    // …and for something nobody asked.
    await search(page).fill('no-such-thing-anywhere');
    await expect(items(page)).toHaveCount(0);
    await expect(state(page)).toHaveText('No prompt matches.');
    await search(page).fill('');
    await expect(items(page)).toHaveCount(3);

    // Open: the past ask is shown on the wall, read-only.
    await alphaRow.getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`/\\?ask=${alpha}$`));
    await expect(page.locator('.wall-view-banner')).toContainText(/Asked on .+ — read-only/);
    await expect(page.locator('.wall-asked-text')).toHaveText('Alpha question about zebras');
    await expect(cells(page)).toHaveCount(2);
    await expectPhase(page, 'a1', 'done');
    await showCell(page, device, 'a2');
    await expect(answer(page, 'a2')).toHaveText('You said: Alpha question about zebras');
    await expect(page.getByRole('form', { name: 'Ask' })).toHaveCount(0);
    await expect(page.locator('.wall-pickers')).toHaveCount(0);
    await expect(page.locator('button[aria-label^="Remove"]')).toHaveCount(0);
    await expect(cancelAllButton(page)).toHaveCount(0);

    // Back to the wall this device was arranging: untouched.
    await page.getByRole('link', { name: 'Back to the wall' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cells(page)).toHaveCount(3);
    await expect(prompt(page)).toHaveValue('');

    // Ask again: cells and prompt are loaded, nothing is sent yet.
    await openHistory(page);
    await item(page, 'Alpha question').getByRole('link', { name: 'Ask again' }).click();
    await expect(page.getByText('Cells and prompt loaded. Press Send to ask again.')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(prompt(page)).toHaveValue('Alpha question about zebras');
    await expect(cells(page)).toHaveCount(2);
    await expect(sendButton(page)).toHaveText('Send to 2');
    expect((await server.api<{ items: unknown[] }>('GET', '/api/history')).json.items.length).toBe(
      3,
    );
    await sendButton(page).click();
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(2);

    await openHistory(page);
    await expect(items(page)).toHaveCount(4);
    await expect(item(page, 'Alpha question')).toHaveCount(2);

    // Delete asks first; cancelling keeps the entry.
    const gammaRow = item(page, 'Gamma question');
    await gammaRow.getByRole('button', { name: 'Delete' }).click();
    await expect(gammaRow).toContainText('Delete this ask and its answers?');
    await gammaRow.getByRole('button', { name: 'Cancel' }).click();
    await expect(gammaRow.getByRole('link', { name: 'Open' })).toBeVisible();
    await gammaRow.getByRole('button', { name: 'Delete' }).click();
    await gammaRow.getByRole('button', { name: 'Delete' }).click();
    await expect(item(page, 'Gamma question')).toHaveCount(0);
    await expect(items(page)).toHaveCount(3);
    expect((await server.api('GET', `/api/history/${gamma}`)).status).toBe(404);
    expect((await server.api('GET', `/api/ask/${gamma}`)).status).toBe(404);
    await page.reload();
    await expect(items(page)).toHaveCount(3);

    // Its address no longer shows anything.
    await page.goto(`/?ask=${gamma}`);
    await expect(page.locator('.wall-view-banner')).toContainText('This ask could not be loaded.');
    await expect(cells(page)).toHaveCount(0);
  });

  test('a long history is loaded page by page', async ({ wallPage: page, server, stub }) => {
    stub.script('quick', { chunks: ['ok'] });
    await server.setProviders({}, [stub.instance()]);
    for (let index = 1; index <= 35; index += 1) {
      const askId = await server.ask(`Paged ask ${String(index).padStart(2, '0')}`, [
        { slotId: 's', providerId: 'stub' },
      ]);
      await server.finished(askId);
    }

    await openHistory(page);
    await expect(items(page)).toHaveCount(30);
    await expect(items(page).first()).toContainText('Paged ask 35');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(items(page)).toHaveCount(35);
    await expect(items(page).last()).toContainText('Paged ask 01');
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

    // A search starts from the first page again.
    await search(page).fill('Paged ask 0');
    await expect(items(page)).toHaveCount(9);
  });

  test('deleting the ask that is on the wall clears the wall', async ({
    wallPage: page,
    guard,
  }) => {
    // The wall still remembers the id of its ask and looks it up once before it lets go.
    guard.allowConsole(/status of 404/);
    await prompt(page).fill('Soon forgotten');
    await sendButton(page).click();
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(3);

    await openHistory(page);
    const row = item(page, 'Soon forgotten');
    await row.getByRole('button', { name: 'Delete' }).click();
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(state(page)).toHaveText('Nothing has been asked yet.');

    await nav(page, 'Wall').click();
    await expect(cells(page)).toHaveCount(3);
    await expect(cells(page).and(page.locator('[data-phase="idle"]'))).toHaveCount(3);
    await expect(page.locator('.wall-asked')).toHaveCount(0);
  });
});
