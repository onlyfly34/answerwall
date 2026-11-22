import { expect, test } from '../support/fixtures.ts';
import { nav } from '../support/wall.ts';
import type { Page } from '@playwright/test';

const WRONG_CODE_MESSAGE =
  'That code is wrong, was already used or has expired. Create a new code and try again.';

const composer = (page: Page) => page.getByRole('form', { name: 'Ask' });
const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in' });

/** A code that is certainly not `code`. */
const wrongCodeFor = (code: string): string => (code === '00000000' ? '11111111' : '00000000');

async function pairWithCode(page: Page, code: string, deviceName: string): Promise<void> {
  await page.getByLabel('Pairing code', { exact: true }).last().fill(code);
  await page.getByLabel('Device name').fill(deviceName);
  await signInButton(page).click();
}

test.describe('pairing and signing in', () => {
  test('the first device pairs with the code from the server log; a wrong code is refused', async ({
    page,
    server,
  }) => {
    const code = await server.firstPairingCode();

    // Any address leads to the sign-in page while there is no session.
    await page.goto('/history');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('AnswerWall');
    await expect(page.getByText('Pair this device with the server to continue.')).toBeVisible();
    await expect(page.getByLabel('Device name')).not.toHaveValue('');
    await expect(page.getByRole('navigation')).toHaveCount(0);

    // Not a code at all: caught in the form, nothing is sent.
    await pairWithCode(page, '1234', 'My laptop');
    await expect(page.getByText('Enter the 8 digits of the pairing code.')).toBeVisible();
    await expect(page.getByLabel('Pairing code', { exact: true }).last()).toBeFocused();

    // A well-formed but wrong code.
    await pairWithCode(page, wrongCodeFor(code), 'My laptop');
    await expect(page.getByRole('alert')).toHaveText(WRONG_CODE_MESSAGE);
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(signInButton(page)).toBeEnabled();

    // The right one, typed the way the log prints it, in two groups.
    await pairWithCode(page, `${code.slice(0, 4)} ${code.slice(4)}`, 'My laptop');
    // The page asked for before signing in is where the user lands.
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();

    // The session survives a reload, and the code cannot be used again.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    const reuse = await page.request.post('/api/auth/pair', {
      headers: { origin: server.base },
      data: { code, deviceName: 'again' },
    });
    expect(reuse.status()).toBe(401);

    // The cookie is not readable by scripts and is bound to this site.
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === 'answerwall_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });
    expect(await page.evaluate(() => document.cookie)).toBe('');

    await nav(page, 'Settings').click();
    const devices = page.getByRole('region', { name: 'Devices' });
    await expect(devices.getByRole('listitem')).toHaveCount(1);
    await expect(devices.getByRole('listitem')).toContainText('My laptop');
    await expect(devices.getByRole('listitem')).toContainText('This device');
  });

  test('a second device pairs with a code created in Settings, once', async ({
    wallPage: page,
    browser,
    guard,
    server,
  }) => {
    await nav(page, 'Settings').click();
    const devices = page.getByRole('region', { name: 'Devices' });
    await expect(devices.getByText('1 of at most 8 devices are paired.')).toBeVisible();
    await devices.getByRole('button', { name: 'Create pairing code' }).click();
    const code = (await devices.locator('.app-pairing-code').innerText()).replace(/\D/g, '');
    expect(code).toMatch(/^\d{8}$/);
    await expect(devices.getByText(/^Valid until /)).toBeVisible();

    const second = await browser.newContext({ baseURL: server.base });
    await guard.watch(second);
    const other = await second.newPage();
    await other.goto('/');
    await expect(other).toHaveURL(/\/sign-in$/);
    await pairWithCode(other, code, 'Second browser');
    await expect(composer(other)).toBeVisible();

    // The first device sees the new one after a reload, and can revoke it.
    await page.reload();
    await expect(devices.getByRole('listitem')).toHaveCount(2);
    await expect(devices.getByText('2 of at most 8 devices are paired.')).toBeVisible();
    await devices.getByRole('button', { name: 'Revoke Second browser' }).click();
    const dialog = page.getByRole('dialog', { name: 'Revoke Second browser?' });
    await expect(dialog).toContainText('signed out at once');
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByText('The device was revoked.')).toBeVisible();
    await expect(devices.getByRole('listitem')).toHaveCount(1);

    // The revoked browser is sent back to the sign-in page by its next request.
    await nav(other, 'History').click();
    await expect(other).toHaveURL(/\/sign-in$/);
    await expect(signInButton(other)).toBeVisible();
    // The used code does not let it back in.
    await pairWithCode(other, code, 'Second browser');
    await expect(other.getByRole('alert')).toHaveText(WRONG_CODE_MESSAGE);
    await second.close();
  });

  test('a code from the "pair" command pairs a device', async ({ page, server }) => {
    const code = await server.pairCommand();
    await page.goto('/');
    await pairWithCode(page, code, 'From the command line');
    await expect(composer(page)).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the access token signs in; a wrong token is refused', async ({ page, server }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Access token').check();
    await expect(page.getByLabel('Device name')).toHaveCount(0);

    await page.locator('input[type="password"]').fill('short');
    await signInButton(page).click();
    await expect(page.getByText('Enter the whole token (at least 16 characters).')).toBeVisible();

    await page.locator('input[type="password"]').fill('not-the-token-0123456789abcdef');
    await signInButton(page).click();
    await expect(page.getByRole('alert')).toHaveText('That token is not accepted.');

    await page.locator('input[type="password"]').fill(server.token);
    await signInButton(page).click();
    await expect(composer(page)).toBeVisible();

    // The token never becomes part of an address or of the page's storage.
    expect(page.url()).not.toContain(server.token);
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, document.cookie]),
    );
    expect(stored).not.toContain(server.token);
  });

  test('repeated wrong codes are slowed down', async ({ page, server, guard }) => {
    guard.allowConsole(/status of 429/);
    const code = await server.firstPairingCode();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await page.request.post('/api/auth/pair', {
        headers: { origin: server.base },
        data: { code: wrongCodeFor(code), deviceName: 'guess' },
      });
      expect(response.status()).toBe(401);
    }
    await page.goto('/sign-in');
    await pairWithCode(page, code, 'Too late');
    await expect(page.getByRole('alert')).toHaveText(
      'Too many failed attempts from this address. Wait a minute, then try again.',
    );
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe('signing out', () => {
  test('signing out returns to the sign-in page and ends the session', async ({
    wallPage: page,
  }) => {
    await nav(page, 'Settings').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(signInButton(page)).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);

    // The session is gone on the server, not just in the page.
    expect((await page.request.get('/api/providers')).status()).toBe(401);
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goBack();
    await expect(signInButton(page)).toBeVisible();
  });

  test('revoking this device returns to the sign-in page', async ({ wallPage: page }) => {
    await nav(page, 'Settings').click();
    const devices = page.getByRole('region', { name: 'Devices' });
    await devices.getByRole('button', { name: /^Revoke e2e/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('This is the device you are using.');
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect((await page.request.get('/api/providers')).status()).toBe(401);
    await page.reload();
    await expect(signInButton(page)).toBeVisible();
  });

  test('a device revoked elsewhere is sent to the sign-in page by its next action', async ({
    wallPage: page,
    server,
  }) => {
    const listed = await server.api<{ devices: { id: string }[] }>('GET', '/api/auth/devices');
    expect(listed.json.devices).toHaveLength(1);
    const revoked = await server.api('DELETE', `/api/auth/devices/${listed.json.devices[0]?.id}`);
    expect(revoked.status).toBeLessThan(300);

    await page.locator('#wall-prompt').fill('Is anyone there?');
    await page.getByRole('form', { name: 'Ask' }).locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(signInButton(page)).toBeVisible();
  });
});
