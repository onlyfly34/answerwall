import { expect, test } from '../support/fixtures.ts';
import { nav } from '../support/wall.ts';

test.describe('settings', () => {
  test('limits are changed, checked against their bounds and enforced', async ({
    wallPage: page,
    server,
    guard,
  }) => {
    guard.allowConsole(/status of 4\d\d/);
    await nav(page, 'Settings').click();
    const limits = page.getByRole('region', { name: 'Limits' });
    await expect(limits).toBeVisible();
    const cellsPerAsk = limits.getByLabel('Cells per ask');
    await expect(cellsPerAsk).toHaveValue('32');

    // Outside its range a value is refused in the form.
    await cellsPerAsk.fill('0');
    await limits.getByRole('button', { name: 'Save' }).click();
    await expect(limits.getByText('Enter a number from 1 to 64.')).toBeVisible();
    await expect(cellsPerAsk).toHaveAttribute('aria-invalid', 'true');

    await cellsPerAsk.fill('2');
    await limits.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect
      .poll(async () => {
        const settings = await server.api<{ settings: { limits: { maxTargetsPerAsk: number } } }>(
          'GET',
          '/api/settings',
        );
        return settings.json.settings.limits.maxTargetsPerAsk;
      })
      .toBe(2);

    // The wall has three cells: one too many for an ask now.
    await nav(page, 'Wall').click();
    await page.locator('#wall-prompt').fill('Too many');
    await expect(page.locator('form.wall-composer button[type="submit"]')).toBeDisabled();
    await expect(page.locator('#wall-composer-hint')).toHaveText(
      '3 cells exceed the limit of 2 per ask.',
    );
    // The server enforces it as well, whatever a client sends.
    const refused = await server.api('POST', '/api/ask', {
      prompt: 'Too many',
      targets: ['a', 'b', 'c'].map((slotId) => ({ slotId, providerId: 'claude' })),
    });
    expect(refused.status).toBe(400);
  });

  test('the about section names the running version and mode', async ({
    wallPage: page,
    server,
  }) => {
    const meta = await server.api<{ version: string; mode: string; name: string }>(
      'GET',
      '/api/meta',
    );
    await nav(page, 'Settings').click();
    const about = page.getByRole('region', { name: 'About' });
    await expect(about).toContainText(meta.json.version);
    await expect(about).toContainText('Server');
    await expect(page.getByRole('region', { name: 'Connection security' })).toContainText(
      'The server itself does not encrypt connections.',
    );
    // On loopback that is safe, so there is no warning banner.
    await expect(page.locator('.app-notice.is-danger')).toHaveCount(0);
  });

  test('a number typed while an earlier change is still being saved is kept @desktop', async ({
    wallPage: page,
    server,
  }) => {
    await nav(page, 'Settings').click();
    const section = page.getByRole('region', { name: 'Wall layout' });
    const columns = section.getByLabel('Number of columns');
    // A slow connection: every save takes a moment to come back.
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'PUT')
        await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });

    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/settings') && response.request().method() === 'PUT',
    );
    await section.getByLabel('A fixed number').check();
    await columns.fill('4');
    await saved;

    // The first save has landed; what the user typed meanwhile is still in the field…
    await expect(columns).toHaveValue('4', { timeout: 2000 });
    await columns.blur();
    // …and is saved in its turn.
    await expect
      .poll(async () => {
        const settings = await server.api<{ settings: { layout: unknown } }>(
          'GET',
          '/api/settings',
        );
        return settings.json.settings.layout;
      })
      .toMatchObject({ mode: 'fixed', columns: 4 });
  });
});
