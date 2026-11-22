import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import { cells, presetBar, send, sendButton } from '../support/wall.ts';

const chip = (page: Page, name: string | RegExp): Locator =>
  presetBar(page).locator('.wall-chip').filter({ hasText: name });

const labels = (page: Page): Promise<string[]> => page.locator('.wall-cell-name').allTextContents();

async function saveAs(page: Page, name: string): Promise<void> {
  await presetBar(page).getByRole('button', { name: 'Save as preset' }).click();
  const input = presetBar(page).getByLabel('Preset name');
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(chip(page, name)).toHaveAttribute('aria-pressed', 'true');
}

interface StoredPreset {
  name: string;
  slots: { providerId: string }[];
}

test.describe('presets', () => {
  test('a wall is saved, switched with one click, updated, renamed and deleted', async ({
    wallPage: page,
    server,
    device,
  }) => {
    const stored = async (): Promise<StoredPreset[]> =>
      (await server.api<{ presets: StoredPreset[] }>('GET', '/api/presets')).json.presets;
    const removeCell = async (label: string): Promise<void> => {
      if (device === 'phone') await page.getByRole('tab', { name: label }).first().click();
      await page
        .getByRole('button', { name: `Remove ${label}` })
        .first()
        .click();
    };

    await expect(presetBar(page).locator('.wall-chip')).toHaveCount(0);
    await expect(presetBar(page).getByRole('button', { name: 'Rename' })).toHaveCount(0);

    // Save the fresh wall of three cells.
    await saveAs(page, 'Trio');
    expect((await stored()).map((preset) => preset.name)).toEqual(['Trio']);

    // Change the wall: the preset is marked as modified and offers an update.
    await removeCell('Codex');
    await expect(cells(page)).toHaveCount(2);
    await expect(chip(page, 'Trio')).toContainText('(modified)');
    await expect(presetBar(page).getByRole('button', { name: 'Update “Trio”' })).toBeVisible();

    // Save the changed wall under another name instead.
    await saveAs(page, 'Duo');
    await expect(chip(page, 'Duo')).not.toContainText('(modified)');
    await expect(chip(page, 'Trio')).toHaveAttribute('aria-pressed', 'false');

    // One click switches the whole wall, back and forth.
    await chip(page, 'Trio').click();
    await expect(cells(page)).toHaveCount(3);
    expect(await labels(page)).toEqual(['Claude', 'Codex', 'Grok']);
    await expect(sendButton(page)).toHaveText('Send to 3');
    await chip(page, 'Duo').click();
    await expect(cells(page)).toHaveCount(2);
    expect(await labels(page)).toEqual(['Claude', 'Grok']);
    await expect(sendButton(page)).toHaveText('Send to 2');

    // The cells of a preset are what an ask goes to.
    await send(page, 'Two of you');
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(2);

    // Update: Duo loses Grok as well.
    await removeCell('Grok');
    await presetBar(page).getByRole('button', { name: 'Update “Duo”' }).click();
    await expect(chip(page, 'Duo')).not.toContainText('(modified)');
    expect((await stored()).find((preset) => preset.name === 'Duo')?.slots).toHaveLength(1);

    // Rename; an empty name is not accepted and cancelling keeps the old one.
    await presetBar(page).getByRole('button', { name: 'Rename' }).click();
    const name = presetBar(page).getByLabel('Preset name');
    await expect(name).toHaveValue('Duo');
    await name.fill('   ');
    await expect(presetBar(page).locator('form button[type="submit"]')).toBeDisabled();
    await presetBar(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(chip(page, 'Duo')).toBeVisible();
    await presetBar(page).getByRole('button', { name: 'Rename' }).click();
    await name.fill('Solo');
    await presetBar(page).locator('form button[type="submit"]').click();
    await expect(chip(page, 'Solo')).toHaveAttribute('aria-pressed', 'true');
    await expect(chip(page, 'Duo')).toHaveCount(0);
    expect((await stored()).map((preset) => preset.name).sort()).toEqual(['Solo', 'Trio']);

    // Presets live on the server: a reload shows them, and the wall is as it was.
    await page.reload();
    await expect(presetBar(page).locator('.wall-chip')).toHaveCount(2);
    await expect(chip(page, 'Solo')).toHaveAttribute('aria-pressed', 'true');
    await expect(cells(page)).toHaveCount(1);

    // Delete asks first.
    await presetBar(page).getByRole('button', { name: 'Delete' }).click();
    await expect(presetBar(page).getByText('Delete the preset “Solo”?')).toBeVisible();
    await presetBar(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(chip(page, 'Solo')).toBeVisible();
    await presetBar(page).getByRole('button', { name: 'Delete' }).click();
    await presetBar(page).getByRole('group').getByRole('button', { name: 'Delete' }).click();
    await expect(chip(page, 'Solo')).toHaveCount(0);
    await expect(presetBar(page).locator('.wall-chip')).toHaveCount(1);
    // The wall keeps its cells; only the preset is gone.
    await expect(cells(page)).toHaveCount(1);
    expect((await stored()).map((preset) => preset.name)).toEqual(['Trio']);
  });

  test('the default preset is chosen per device and opens with a new session', async ({
    wallPage: page,
    context,
    browser,
    guard,
    server,
  }) => {
    await server.putPreset('p-pair', {
      name: 'Pair',
      slots: [
        { slotId: 'a', providerId: 'grok' },
        { slotId: 'b', providerId: 'claude', model: 'haiku' },
      ],
    });
    await page.reload();
    await expect(cells(page)).toHaveCount(3);

    await chip(page, 'Pair').click();
    await presetBar(page).getByRole('button', { name: 'Default', exact: true }).click();
    await expect(chip(page, 'Pair')).toContainText('(default)');
    await expect(
      presetBar(page).getByRole('button', { name: 'Default', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');

    // A new tab is a new session on the same device: it opens with the default preset.
    const tab = await context.newPage();
    await tab.goto('/');
    await expect(cells(tab)).toHaveCount(2);
    expect(await labels(tab)).toEqual(['Grok', 'Claude']);
    await expect(chip(tab, 'Pair')).toHaveAttribute('aria-pressed', 'true');
    await expect(cells(tab).nth(1).locator('.wall-cell-model')).toHaveText('haiku');

    // Another device sees the preset, but has no default of its own.
    const second = await browser.newContext({ baseURL: server.base });
    await guard.watch(second);
    const paired = await second.request.post('/api/auth/pair', {
      headers: { origin: server.base },
      data: { code: await server.mintPairingCode(), deviceName: 'second device' },
    });
    expect(paired.status()).toBe(200);
    const other = await second.newPage();
    await other.goto('/');
    await expect(chip(other, 'Pair')).toBeVisible();
    await expect(chip(other, 'Pair')).not.toContainText('(default)');
    await expect(cells(other)).toHaveCount(3);
    await second.close();

    // Switching the default off again.
    await presetBar(tab).getByRole('button', { name: 'Default', exact: true }).click();
    await expect(chip(tab, 'Pair')).not.toContainText('(default)');
    const fresh = await context.newPage();
    await fresh.goto('/');
    await expect(cells(fresh)).toHaveCount(3);
  });
});
