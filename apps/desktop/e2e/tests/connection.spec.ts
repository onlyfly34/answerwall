import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, pageApi, test, until } from '../support/fixtures.ts';

const wall = (page: Page) => page.getByRole('form', { name: 'Ask' });

/** A loopback port on which nothing listens. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function pair(page: Page, code: string): Promise<void> {
  await page.getByLabel('Pairing code', { exact: true }).last().fill(code);
  await page.getByLabel('Device name').fill('Desktop app');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('the connection page', () => {
  test('first run: choosing this computer starts the local server, and the choice is remembered', async ({
    launch,
    profile,
  }) => {
    const first = await launch();
    const connection = await first.connectionWindow();
    await expect(connection).toHaveTitle('AnswerWall: Connection');
    await expect(connection.getByRole('heading', { level: 1 })).toHaveText('Connection');
    const proceed = connection.getByRole('button', { name: 'Continue' });
    await expect(proceed).toBeDisabled();
    // Nothing runs before the user has chosen.
    expect(first.electron.windows()).toHaveLength(1);
    expect(await first.log()).not.toContain('the local server is listening');
    // The page is one bundled file and reaches nothing else.
    expect(
      await connection.evaluate(() => Object.keys(window).filter((key) => /answerwall/.test(key))),
    ).toEqual(['answerwallConnection']);

    await connection.getByRole('radio', { name: /This computer/ }).check();
    await proceed.click();

    const page = await first.contentWindow();
    await expect(wall(page)).toBeVisible();
    await until('the connection page to close', () => connection.isClosed());
    const origin = new URL(page.url()).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await pageApi<{ mode: string }>(page, 'GET', '/api/meta')).json.mode).toBe('desktop');
    expect(await profile.settings()).toMatchObject({
      mode: 'local',
      localPort: Number(new URL(origin).port),
    });
    // A local instance has no devices to pair.
    await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Devices' })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('e2e.kept', 'yes'));
    await first.quit();

    // The next start goes straight to the wall, on the same origin, with what the page stored.
    const second = await launch();
    const again = await second.contentWindow();
    await expect(wall(again)).toBeVisible();
    expect(new URL(again.url()).origin).toBe(origin);
    expect(await again.evaluate(() => localStorage.getItem('e2e.kept'))).toBe('yes');
    expect(second.electron.windows().filter((window) => !window.isClosed())).toHaveLength(1);
  });

  test('a remote server is checked, loaded in its own window and paired there', async ({
    launch,
    profile,
    server,
  }) => {
    const first = await launch();
    const connection = await first.connectionWindow();
    await connection.getByRole('radio', { name: /A server/ }).check();
    const address = connection.getByLabel('Server address');
    const result = connection.getByRole('status');

    // Addresses that are refused before anything is requested.
    for (const [input, message] of [
      ['http://8.8.8.8:7717', 'Plain HTTP is allowed only for this computer'],
      ['https://user:pw@wall.example.com', 'must not contain a user name or a password'],
      ['ftp://wall.example.com', 'must start with https:// or http://'],
      [`${server.base}/app`, 'without a path'],
    ] as const) {
      await address.fill(input);
      await connection.getByRole('button', { name: 'Check' }).click();
      await expect(result).toContainText(message);
    }

    // Plain HTTP on loopback: allowed, with a warning that stays on screen.
    await address.fill(server.base);
    await expect(connection.getByText('This address uses plain HTTP')).toBeVisible();
    await connection.getByRole('button', { name: 'Check' }).click();
    await expect(result).toContainText('Found AnswerWall 0.0.0 (protocol version 1).');
    await connection.getByRole('button', { name: 'Continue' }).click();

    const page = await first.contentWindow();
    expect(new URL(page.url()).origin).toBe(server.base);
    await expect(page.getByLabel('Device name')).toBeVisible();
    await until('the connection page to close', () => connection.isClosed());
    expect(await profile.settings()).toMatchObject({ mode: 'remote', remoteUrl: server.base });
    // The window says for as long as it is open that the connection is not encrypted.
    const title = await first.electron.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '',
    );
    expect(title).toContain(`not encrypted: ${server.base}`);
    // The remote window has no bridge to the shell, and no local server runs for it.
    expect(
      await page.evaluate(() => Object.keys(window).filter((key) => /answerwall/i.test(key))),
    ).toEqual([]);
    expect(await first.log()).not.toContain('the local server is listening');
    expect((await first.processes()).some((one) => /NodeService/.test(one.commandLine))).toBe(
      false,
    );

    await pair(page, await server.firstPairingCode());
    await expect(wall(page)).toBeVisible();
    await first.quit();

    // The pairing lives in the remote window's own cookie store and survives a restart.
    const second = await launch();
    const again = await second.contentWindow();
    expect(new URL(again.url()).origin).toBe(server.base);
    await expect(wall(again)).toBeVisible();
    const devices = await server.api<{ devices: { name: string }[] }>('GET', '/api/auth/devices');
    expect(devices.json.devices.map((device) => device.name)).toEqual(['Desktop app']);
  });

  test('a saved server that does not answer brings up the connection page; local mode is one click away', async ({
    launch,
    profile,
  }) => {
    const dead = `http://127.0.0.1:${await closedPort()}`;
    await profile.seed({ mode: 'remote', remoteUrl: dead });

    const app = await launch();
    const connection = await app.connectionWindow();
    await expect(connection.getByRole('alert')).toHaveText(
      'The saved connection did not work. The server did not answer. Check the address and that the server is running.',
    );
    await expect(connection.getByRole('radio', { name: /A server/ })).toBeChecked();
    await expect(connection.getByLabel('Server address')).toHaveValue(dead);
    expect(app.electron.windows()).toHaveLength(1);

    // Trying again fails on the page, and the page stays.
    await connection.getByRole('button', { name: 'Continue' }).click();
    await expect(connection.getByRole('status')).toContainText('The server did not answer.');

    await connection.getByRole('radio', { name: /This computer/ }).check();
    await connection.getByRole('button', { name: 'Continue' }).click();
    await expect(wall(await app.contentWindow())).toBeVisible();
    // The address is kept for the next time.
    expect(await profile.settings()).toMatchObject({ mode: 'local', remoteUrl: dead });
  });

  test('switching from this computer to a server, from the menu, without restarting', async ({
    local,
    profile,
    server,
  }) => {
    const { app, page } = local;
    const localOrigin = new URL(page.url()).origin;
    expect((await app.processes()).some((one) => /NodeService/.test(one.commandLine))).toBe(true);

    // File > Connection…
    await app.clickMenu(0, 0);
    const connection = await app.connectionWindow();
    await expect(connection.getByRole('radio', { name: /This computer/ })).toBeChecked();
    // Closing the page changes nothing.
    await expect(wall(page)).toBeVisible();

    await connection.getByRole('radio', { name: /A server/ }).check();
    await connection.getByLabel('Server address').fill(server.base);
    await connection.getByRole('button', { name: 'Continue' }).click();

    const remote = await until('the remote window', () =>
      app.electron
        .windows()
        .find((window) => !window.isClosed() && window.url().startsWith(server.base)),
    );
    await expect(remote.getByLabel('Device name')).toBeVisible();
    await until('the local window to close', () => page.isClosed());
    expect(await profile.settings()).toMatchObject({ mode: 'remote', remoteUrl: server.base });

    // The local server is no longer needed and is gone, port and all.
    await until('the local server to stop', async () => {
      return !(await app.processes()).some((one) => /NodeService/.test(one.commandLine));
    });
    await expect(fetch(`${localOrigin}/api/meta`)).rejects.toThrow();

    // And back again.
    await app.clickMenu(0, 0);
    const back = await app.connectionWindow();
    await back.getByRole('radio', { name: /This computer/ }).check();
    await back.getByRole('button', { name: 'Continue' }).click();
    const localAgain = await until('the local window', () =>
      app.electron
        .windows()
        .find(
          (window) =>
            !window.isClosed() &&
            window.url().startsWith('http://127.0.0.1') &&
            !window.url().startsWith(server.base),
        ),
    );
    await expect(wall(localAgain)).toBeVisible();
    await until('the remote window to close', () => remote.isClosed());
  });

  test('the update setting is shared with the local server’s settings', async ({ local }) => {
    const { app, page } = local;
    const read = async (): Promise<boolean> =>
      (await pageApi<{ settings: { updateCheck: boolean } }>(page, 'GET', '/api/settings')).json
        .settings.updateCheck;
    expect(await read()).toBe(true);

    await app.clickMenu(0, 0);
    const connection = await app.connectionWindow();
    const box = connection.getByRole('checkbox', { name: 'Check for updates when the app starts' });
    // This build cannot update itself (it is not an installed Windows build, or
    // the tests switched updates off), and the page says so.
    await expect(connection.getByText('This build does not update itself.')).toBeVisible();
    await expect(box).toBeDisabled();
    await expect(box).toBeChecked();
  });
});
