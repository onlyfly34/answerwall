import { expect, test } from '../support/fixtures.ts';
import {
  expectInert,
  expectNoSmuggledElements,
  expectNothingRan,
  hostileMarkdown,
  hostileName,
} from '../support/hostile.ts';
import {
  answer,
  arrange,
  cells,
  currentAskId,
  expectPhase,
  expectPhases,
  nav,
  presetBar,
  send,
  showCell,
} from '../support/wall.ts';

const EXPECTED_CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

/** The answer in pieces of a few characters, so tags arrive torn apart as they would from a model. */
function torn(text: string, size = 7): string[] {
  const pieces: string[] = [];
  for (let index = 0; index < text.length; index += size)
    pieces.push(text.slice(index, index + size));
  return pieces;
}

test.describe('untrusted content', () => {
  test('a hostile streamed answer loads nothing and runs nothing', async ({
    wallPage: page,
    server,
    stub,
    canary,
    guard,
    device,
  }) => {
    const hostile = hostileMarkdown(canary.origin);
    const pieces = torn(hostile);
    const half = Math.floor(pieces.length / 2);
    stub.script('hostile', { chunks: pieces, holdAt: [half] });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [
      { slotId: 'h1', providerId: 'stub' },
      { slotId: 'h2', providerId: 'stub' },
    ]);
    await send(page, 'Answer with something hostile');

    // Half way: whatever fragment is on screen is inert too.
    await stub.held('hostile', 2);
    await expectPhases(page, { h1: 'streaming', h2: 'streaming' });
    await expect(answer(page, 'h1')).toContainText('Hostile answer');
    await expectInert(answer(page, 'h1'));
    await expectNothingRan(page);

    stub.release('hostile');
    await expectPhases(page, { h1: 'done', h2: 'done' });
    for (const slotId of ['h1', 'h2']) {
      await showCell(page, device, slotId);
      await expect(answer(page, slotId)).toContainText('The end of the hostile answer.');
      await expectInert(answer(page, slotId));
    }
    await expectNothingRan(page);

    // Raw HTML is shown as the text it is; a Markdown image is a link, not an image.
    const shown = answer(page, 'h2');
    await expect(shown).toContainText('<script>');
    await expect(shown).toContainText(`<img src="${canary.origin}/img-tag.png">`);
    const image = shown.getByRole('link', { name: 'markdown image' });
    await expect(image).toHaveAttribute('href', `${canary.origin}/markdown-image.png`);
    await expect(image).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(image).toHaveAttribute('target', '_blank');
    // Links into this application or with a script scheme are not links at all.
    for (const name of [
      'javascript link',
      'mixed case',
      'entity',
      'vbscript',
      'relative',
      'protocol relative',
      'reference link',
    ]) {
      await expect(shown.getByRole('link', { name, exact: true })).toHaveCount(0);
      await expect(shown.getByText(name, { exact: true }).first()).toBeVisible();
    }
    // The text that tried to cover the page is ordinary text inside its cell.
    const cover = await shown.getByText('covers the page').evaluate((element) => {
      const style = getComputedStyle(element);
      return { position: style.position, background: style.backgroundImage };
    });
    expect(cover).toEqual({ position: 'static', background: 'none' });

    // Hovering, clicking and focusing the rendered text sets nothing off.
    await shown.getByText('hover me').hover();
    await shown.getByText('hover me').click();
    await shown.getByText('raw anchor').click();
    await shown.getByText('javascript link', { exact: true }).click();
    await expectNothingRan(page);

    // The server kept the answer byte for byte: it is the page that neutralises it.
    const snapshot = await server.snapshot(await currentAskId(page));
    expect(snapshot.slots.map((slot) => slot.text)).toEqual([hostile, hostile]);

    // After a reload the stored answer is rendered again, just as inert.
    await page.reload();
    await expectPhases(page, { h1: 'done', h2: 'done' });
    await expect(answer(page, 'h1')).toContainText('The end of the hostile answer.');
    await expectInert(answer(page, 'h1'));
    await expectNothingRan(page);

    // The proof that counts: not one request left for another origin, the
    // canary heard nothing, and the policy never had to step in.
    await page.waitForLoadState('networkidle');
    expect(guard.foreignRequests).toEqual([]);
    expect(canary.requests).toEqual([]);
    expect(guard.cspViolations).toEqual([]);
    expect(guard.dialogs).toEqual([]);
  });

  test('a hostile prompt is inert on the wall, in the history and in every name', async ({
    wallPage: page,
    server,
    canary,
    guard,
    device,
  }) => {
    const hostile = hostileMarkdown(canary.origin);
    // The same markup as a preset name, a provider label and a device name.
    const name = hostileName(canary.origin);
    await server.setProviders({ grok: { label: name } });
    await server.putPreset('p-hostile', {
      name,
      slots: [
        { slotId: 'e1', providerId: 'claude', model: 'mock-echo' },
        { slotId: 'e2', providerId: 'grok', model: 'mock-echo' },
      ],
    });
    const paired = await page.request.post('/api/auth/pair', {
      headers: { origin: server.base },
      data: { code: await server.mintPairingCode(), deviceName: name },
    });
    expect(paired.status()).toBe(200);

    await page.reload();
    const chip = presetBar(page).locator('.wall-chip');
    await expect(chip).toHaveText(name);
    await chip.click();
    await expect(cells(page)).toHaveCount(2);
    await expect(cells(page).nth(1).locator('.wall-cell-name')).toHaveText(name);

    // The prompt goes to CLIs that answer with it, so it comes back as an answer.
    await send(page, hostile);
    await expectPhases(page, { e1: 'done', e2: 'done' });
    for (const slotId of ['e1', 'e2']) {
      await showCell(page, device, slotId);
      await expect(answer(page, slotId)).toContainText('The end of the hostile answer.');
      await expectInert(answer(page, slotId));
    }
    // The prompt itself is shown as plain text.
    await page.locator('.wall-asked summary').click();
    await expect(page.locator('.wall-asked-text')).toContainText('<script>');
    await expect(page.locator('.wall-asked-text')).toContainText('The end of the hostile answer.');
    await expect(page.locator('.wall-asked-text *')).toHaveCount(0);
    await expectNoSmuggledElements(page);
    await expectNothingRan(page);
    expect((await server.snapshot(await currentAskId(page))).prompt).toBe(hostile);

    // History: the preview, then the stored ask opened read-only.
    await nav(page, 'History').click();
    const row = page.locator('.wall-history-item');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.wall-history-prompt')).toContainText('# Hostile answer');
    await expect(row.locator('.wall-history-prompt *')).toHaveCount(0);
    await expect(row.locator('.wall-history-slots')).toContainText(name);
    await expectNoSmuggledElements(page);
    await row.getByRole('link', { name: 'Open' }).click();
    await expectPhase(page, 'e1', 'done');
    await showCell(page, device, 'e2');
    await expect(answer(page, 'e2')).toContainText('The end of the hostile answer.');
    await expectInert(answer(page, 'e2'));
    await expect(page.locator('.wall-asked-text *')).toHaveCount(0);
    await expectNoSmuggledElements(page);

    // The names, wherever else they are shown.
    await nav(page, 'Providers').click();
    await expect(page.getByRole('region', { name, exact: true }).locator('h3')).toContainText(name);
    await expectNoSmuggledElements(page);
    await nav(page, 'Settings').click();
    const devices = page.getByRole('region', { name: 'Devices' });
    await expect(devices.getByRole('listitem')).toHaveCount(2);
    await expect(devices.locator('strong').filter({ hasText: name })).toHaveCount(1);
    await expectNoSmuggledElements(page);
    await expectNothingRan(page);

    await page.waitForLoadState('networkidle');
    expect(guard.foreignRequests).toEqual([]);
    expect(canary.requests).toEqual([]);
    expect(guard.cspViolations).toEqual([]);
    expect(guard.dialogs).toEqual([]);
  });

  test('an error message from a provider is shown as text', async ({
    wallPage: page,
    server,
    stub,
    canary,
    guard,
  }) => {
    const message = `<img src="${canary.origin}/error.png" onerror="window.__pwned='error'"> quota exceeded`;
    stub.script('broken', { chunks: [], error: { status: 429, body: { error: { message } } } });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [{ slotId: 'b1', providerId: 'stub' }]);
    await send(page, 'Fail with markup');
    await expectPhase(page, 'b1', 'error');
    const alert = cells(page).first().getByRole('alert');
    await expect(alert.locator('strong')).not.toBeEmpty();
    await expect(alert.locator('img')).toHaveCount(0);
    await expectNothingRan(page);
    expect(guard.foreignRequests).toEqual([]);
    expect(canary.requests).toEqual([]);
  });
});

test.describe('the checks of this suite', () => {
  test('notice markup that was let through, and a load the policy had to stop', async ({
    wallPage: page,
    canary,
    guard,
  }) => {
    // What a broken sanitiser would leave behind, put there by hand.
    await page.evaluate((origin) => {
      const leaked = document.createElement('div');
      leaked.id = 'leaked';
      leaked.innerHTML =
        '<a href="javascript:void 0" onclick="void 0">x</a><svg></svg>' +
        `<img src="${origin}/leaked.png">`;
      document.body.append(leaked);
    }, canary.origin);

    await expect(expectInert(page.locator('#leaked'))).rejects.toThrow();
    await expect(expectNoSmuggledElements(page)).rejects.toThrow();
    // The policy blocked the image; the suite saw that it had to.
    await expect
      .poll(() => guard.cspViolations.map((violation) => violation.directive))
      .toContain('img-src');
    expect(
      guard.cspViolations.some((violation) => violation.blockedUri.startsWith(canary.origin)),
    ).toBe(true);
    expect(canary.requests).toEqual([]);

    // This test caused them on purpose.
    guard.cspViolations.length = 0;
    guard.consoleErrors.length = 0;
  });
});

test.describe('content security policy', () => {
  test('every page is served with the policy of the decisions document', async ({
    wallPage: page,
    server,
  }) => {
    for (const path of ['/', '/history', '/providers', '/settings', '/sign-in', '/no-such-page']) {
      const response = await page.request.get(path);
      const headers = response.headers();
      expect(headers['content-security-policy'], path).toBe(EXPECTED_CSP);
      expect(headers['x-content-type-options'], path).toBe('nosniff');
      expect(
        Object.keys(headers).filter((name) => name.startsWith('access-control-')),
        `no CORS headers on ${path}`,
      ).toEqual([]);
    }
    // The API answers carry it as well, and are never cached.
    const api = await page.request.get('/api/providers');
    expect(api.headers()['content-security-policy']).toBe(EXPECTED_CSP);
    const stream = await server.api('GET', '/api/meta');
    expect(stream.status).toBe(200);

    // The document itself holds no inline script and loads nothing from elsewhere.
    const html = await (await page.request.get('/')).text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    const sources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(sources.filter((source) => !source.startsWith('/'))).toEqual([]);
  });

  test('the app runs clean under the policy: no violation on any page', async ({
    wallPage: page,
    guard,
  }) => {
    // Visit everything and use it once.
    await send(page, 'Run clean');
    await expect(cells(page).and(page.locator('[data-phase="done"]'))).toHaveCount(3);
    for (const name of ['History', 'Providers', 'Settings', 'Wall']) {
      await nav(page, name).click();
      await expect(nav(page, name)).toHaveClass(/is-active/);
    }
    await page.reload();
    await expect(cells(page)).toHaveCount(3);
    await page.waitForLoadState('networkidle');

    expect(guard.consoleErrors).toEqual([]);
    expect(guard.pageErrors).toEqual([]);
    expect(guard.cspViolations, 'Content-Security-Policy violations').toEqual([]);
  });
});
