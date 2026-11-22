/**
 * Web cells as the server and its own page see them: the settings, and a web
 * slot whose result a scripted client submits. The browser extension that
 * really fills such a slot is tested in `web-cells/`.
 */
import { expect, test } from '../support/fixtures.ts';
import { expectInert, expectNothingRan, hostileMarkdown } from '../support/hostile.ts';
import type { TestServer } from '../support/server.ts';
import { answer, cells, expectPhase, nav, showCell } from '../support/wall.ts';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

interface StoredSettings {
  settings: {
    webCells: {
      enabled: boolean;
      fillPrompt: boolean;
      readAnswer: boolean;
      extensionIds: string[];
    };
    providers: { id: string; kind: string; enabled: boolean; [key: string]: unknown }[];
  };
}

const settingsOf = async (server: TestServer): Promise<StoredSettings['settings']> =>
  (await server.api<StoredSettings>('GET', '/api/settings')).json.settings;

/** Web cells on, with the web provider of one site, as the settings page would save it. */
async function enableWebCells(server: TestServer): Promise<void> {
  const { providers } = await settingsOf(server);
  const saved = await server.api('PUT', '/api/settings', {
    webCells: { enabled: true, fillPrompt: true, readAnswer: true },
    providers: [
      ...providers,
      {
        id: 'web-chatgpt',
        kind: 'web',
        site: 'chatgpt',
        label: 'ChatGPT (web)',
        enabled: true,
        concurrency: 2,
        models: [],
      },
    ],
  });
  expect(saved.status).toBe(200);
}

const webAsk = (server: TestServer, prompt: string) =>
  server.api<{ askId: string; error?: { code: string } }>('POST', '/api/ask', {
    prompt,
    targets: [
      { slotId: 'w1', providerId: 'web-chatgpt' },
      { slotId: 'c1', providerId: 'claude', model: 'mock-echo' },
    ],
    runsWebSlots: true,
  });

test.describe('web cells', () => {
  test('everything is off until it is switched on in the settings', async ({
    wallPage: page,
    server,
  }) => {
    expect((await settingsOf(server)).webCells).toEqual({
      enabled: false,
      fillPrompt: false,
      readAnswer: false,
      extensionIds: [],
    });
    // While it is off the server takes no web slot, whatever the client declares.
    const refused = await server.api<{ error: { code: string } }>('POST', '/api/ask', {
      prompt: 'hi',
      targets: [{ slotId: 'w1', providerId: 'web-chatgpt' }],
      runsWebSlots: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('unknown_provider');

    await nav(page, 'Settings').click();
    const section = page.getByRole('region', { name: 'Web cells' });
    await expect(section.getByText(/restrict automated access/)).toBeVisible();
    for (const name of ['Allow web cells', 'Fill in the prompt', 'Read the answer']) {
      await expect(section.getByRole('checkbox', { name })).not.toBeChecked();
    }

    await section.getByRole('checkbox', { name: 'Allow web cells' }).check();
    await section.getByRole('checkbox', { name: 'Read the answer' }).check();
    await section.getByLabel('Extension ID').fill('not an id');
    await section.getByRole('button', { name: 'Add' }).click();
    await expect(section.getByLabel('Extension ID')).toHaveAttribute('aria-invalid', 'true');
    await section.getByLabel('Extension ID').fill(EXTENSION_ID);
    await section.getByRole('button', { name: 'Add' }).click();
    await expect(section.getByRole('listitem')).toContainText(EXTENSION_ID);
    await section.getByRole('checkbox', { name: /chatgpt\.com/ }).check();

    await expect
      .poll(async () => {
        const stored = await settingsOf(server);
        return {
          webCells: stored.webCells,
          web: stored.providers.filter((provider) => provider.kind === 'web').map((p) => p.id),
        };
      })
      .toEqual({
        webCells: {
          enabled: true,
          fillPrompt: false,
          readAnswer: true,
          extensionIds: [EXTENSION_ID],
        },
        web: ['web-chatgpt'],
      });

    // The settings survive a reload of the page.
    await page.reload();
    await expect(section.getByRole('checkbox', { name: 'Allow web cells' })).toBeChecked();
    await expect(section.getByRole('checkbox', { name: 'Fill in the prompt' })).not.toBeChecked();
    await expect(section.getByRole('checkbox', { name: /chatgpt\.com/ })).toBeChecked();

    // This page is not the extension: its wall and its providers page offer no web cell.
    await nav(page, 'Providers').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Providers' })).toBeVisible();
    await expect(page.getByText('ChatGPT (web)')).toHaveCount(0);
    await nav(page, 'Wall').click();
    await expect(cells(page).first()).toBeVisible();
    await expect(page.locator('option', { hasText: 'ChatGPT (web)' })).toHaveCount(0);
  });

  test('a web slot answered by a scripted client is stored and shown like any other answer', async ({
    wallPage: page,
    server,
    canary,
    device,
    guard,
  }) => {
    await enableWebCells(server);
    const hostile = hostileMarkdown(canary.origin);

    // A client that does not say it runs web slots is refused.
    const undeclared = await server.api<{ error: { code: string } }>('POST', '/api/ask', {
      prompt: 'hi',
      targets: [{ slotId: 'w1', providerId: 'web-chatgpt' }],
    });
    expect(undeclared.json.error.code).toBe('web_client_required');

    const created = await webAsk(server, 'A question for a web cell');
    expect(created.status).toBe(200);
    const { askId } = created.json;

    // The server runs nothing for the slot: it is running until its client answers.
    await expect
      .poll(async () => {
        const snapshot = await server.snapshot(askId);
        return snapshot.slots.map((slot) => `${slot.slotId}:${slot.status}`);
      })
      .toEqual(['w1:running', 'c1:done']);
    expect((await server.snapshot(askId)).status).toBe('running');

    // The browser is another device than the scripted client: it may not answer for it.
    const forged = await page.request.post(`/api/ask/${askId}/slots/w1/result`, {
      headers: { origin: server.base },
      data: { outcome: 'done', text: 'forged' },
    });
    expect(forged.status()).toBe(403);

    const submitted = await server.api('POST', `/api/ask/${askId}/slots/w1/result`, {
      outcome: 'done',
      text: hostile,
    });
    expect(submitted).toEqual({ status: 200, json: { status: 'done', truncated: false } });
    const finished = await server.finished(askId);
    expect(finished.slots[0]).toMatchObject({ status: 'done', text: hostile });

    // The same result again is fine; a second, different one is not.
    const again = await server.api('POST', `/api/ask/${askId}/slots/w1/result`, {
      outcome: 'done',
      text: hostile,
    });
    expect(again.status).toBe(200);
    const other = await server.api('POST', `/api/ask/${askId}/slots/w1/result`, {
      outcome: 'failed',
      code: 'unknown',
    });
    expect(other.status).toBe(409);

    // Another device opens it from the history: rendered through the same
    // sanitising path as every answer, and just as inert.
    await nav(page, 'History').click();
    const row = page.locator('.wall-history-item').filter({ hasText: 'A question for a web cell' });
    await expect(row.getByRole('listitem').first()).toContainText(/done/);
    await row.getByRole('link', { name: 'Open' }).click();
    await expect(cells(page)).toHaveCount(2);
    await showCell(page, device, 'w1');
    await expectPhase(page, 'w1', 'done');
    await expect(answer(page, 'w1')).toContainText('The end of the hostile answer.');
    await expectInert(answer(page, 'w1'));
    await expectNothingRan(page);
    await page.waitForLoadState('networkidle');
    expect(guard.foreignRequests).toEqual([]);
    expect(canary.requests).toEqual([]);
    expect(guard.cspViolations).toEqual([]);
  });

  test('a web slot is cancelled from another device, fails with a reason, or times out', async ({
    page,
    signIn,
    server,
  }) => {
    await enableWebCells(server);
    await signIn();

    // Cancelled by the browser, which did not create the ask.
    const first = (await webAsk(server, 'cancelled elsewhere')).json.askId;
    const cancel = await page.request.post(`/api/ask/${first}/cancel`, {
      headers: { origin: server.base },
      data: { slotId: 'w1' },
    });
    expect(await cancel.json()).toEqual({ cancelled: ['w1'] });
    expect((await server.finished(first)).slots[0]).toMatchObject({ status: 'cancelled' });
    const late = await server.api('POST', `/api/ask/${first}/slots/w1/result`, {
      outcome: 'done',
      text: 'too late',
    });
    expect(late.status).toBe(409);
    expect((await server.snapshot(first)).slots[0]?.text).toBe('');

    // Failed, with the reason the client gives.
    const second = (await webAsk(server, 'signed out of the site')).json.askId;
    const failed = await server.api('POST', `/api/ask/${second}/slots/w1/result`, {
      outcome: 'failed',
      code: 'not_logged_in',
      message: 'The site shows its sign-in page.',
    });
    expect(failed.json).toEqual({ status: 'error', truncated: false });
    expect((await server.finished(second)).slots[0]).toMatchObject({
      status: 'error',
      error: { code: 'not_logged_in', message: 'The site shows its sign-in page.' },
    });

    // Never answered: the slot timeout ends it.
    await server.setLimits({ slotTimeoutMs: 5000 });
    const third = (await webAsk(server, 'never answered')).json.askId;
    expect((await server.finished(third)).slots[0]).toMatchObject({ status: 'timeout' });
    const afterTimeout = await server.api('POST', `/api/ask/${third}/slots/w1/result`, {
      outcome: 'done',
      text: 'too late',
    });
    expect(afterTimeout.status).toBe(409);
  });
});
