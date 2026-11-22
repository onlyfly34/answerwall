/**
 * The extension's page against a real AnswerWall server on another origin:
 * the Origin allowlist, pairing that returns a device token, a streamed
 * response read with `fetch`, and a web slot from the ask to the stored
 * answer. The compiled server and the mock CLIs are the ones of the other
 * end-to-end tests; the site is the local stand-in.
 */
import type { Page } from '@playwright/test';
import type { TestServer } from '../support/server.ts';
import { cells, currentAskId, send } from '../support/wall.ts';
import { expect, test } from './support/fixtures.ts';

interface ProviderEntry {
  id: string;
  [key: string]: unknown;
}

const WEB_PROVIDER = {
  id: 'web-claude',
  kind: 'web',
  site: 'claude',
  label: 'Stand-in site',
  enabled: true,
  concurrency: 2,
  models: [],
};

/** Switches web cells on, allows the given extensions and adds one web provider. */
async function allowWebCells(server: TestServer, extensionIds: string[]): Promise<void> {
  const current = await server.api<{ settings: { providers: ProviderEntry[] } }>(
    'GET',
    '/api/settings',
  );
  const providers = current.json.settings.providers.filter(
    (provider) => provider.id !== WEB_PROVIDER.id,
  );
  const saved = await server.api('PUT', '/api/settings', {
    webCells: { enabled: true, fillPrompt: true, readAnswer: true, extensionIds },
    providers: [...providers, WEB_PROVIDER],
  });
  expect(saved.status).toBe(200);
}

const callApi = (
  wall: Page,
  server: TestServer,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) =>
  wall.evaluate(
    ([base, bearer, verb, target, payload]) =>
      window.wall.api(base, bearer, verb, target, payload ?? undefined),
    [server.base, token, method, path, body ?? null] as const,
  );

async function pairExtension(wall: Page, server: TestServer): Promise<string> {
  const paired = await callApi(wall, server, null, 'POST', '/api/auth/pair', {
    code: await server.mintPairingCode(),
    deviceName: 'Test extension',
  });
  expect(paired.status).toBe(200);
  const { token } = paired.json as { token?: string };
  expect(token, 'the device token in the pairing answer').toMatch(/^[\w-]{40,}$/);
  return token ?? '';
}

test('(d) what a request of the extension page looks like to a server', async ({
  vendor,
  extensionId,
  openWall,
}) => {
  // The stand-in records what it receives; the extension has host permission for it too.
  const wall = await openWall();
  vendor.requests.length = 0;
  await wall.evaluate(async (base) => {
    await window.wall.api(base, null, 'GET', '/framable');
    await window.wall.api(base, null, 'POST', '/no-such-path', {});
  }, vendor.origin);

  const read = vendor.requests.find((request) => request.path === '/framable');
  const write = vendor.requests.find((request) => request.path === '/no-such-path');
  test
    .info()
    .annotations.push(
      { type: 'GET from the extension page', description: JSON.stringify(read) },
      { type: 'POST from the extension page', description: JSON.stringify(write) },
    );
  // Chromium names the extension on a write and sends no Origin on a read,
  // so a server can tell extensions apart only on state-changing requests.
  expect(write?.origin).toBe(`chrome-extension://${extensionId}`);
  expect(read?.origin).toBeUndefined();
  // Without `credentials: 'include'` no cookie travels.
  expect(read?.cookies).toEqual([]);
  expect(write?.cookies).toEqual([]);
});

test('(d) an extension cannot pair until its id is on the allowlist', async ({
  server,
  extensionId,
  openWall,
}) => {
  const wall = await openWall();
  const pair = async () =>
    callApi(wall, server, null, 'POST', '/api/auth/pair', {
      code: await server.mintPairingCode(),
      deviceName: 'Test extension',
    });

  // Web cells are off: every state-changing request of an extension is refused.
  expect(await pair()).toMatchObject({ status: 403, json: { error: { code: 'forbidden' } } });
  // The one unauthenticated read stays what it is for anybody; everything else needs a token.
  const meta = await callApi(wall, server, null, 'GET', '/api/meta');
  expect(meta.status).toBe(200);
  // No CORS header is needed for an extension page with host permission, and none is sent.
  expect(meta.allowOrigin).toBeNull();
  expect((await callApi(wall, server, null, 'GET', '/api/settings')).status).toBe(401);

  // Another extension's id on the list does not help this one.
  await allowWebCells(server, ['ponmlkjihgfedcbaponmlkjihgfedcba']);
  expect((await pair()).status).toBe(403);

  await allowWebCells(server, [extensionId]);
  const paired = await pair();
  expect(paired.status).toBe(200);
  expect(paired.allowOrigin).toBeNull();
  const { token } = paired.json as { token: string };

  // Switching web cells off closes the door again at once, token or not.
  expect((await server.api('PUT', '/api/settings', { webCells: { enabled: false } })).status).toBe(
    200,
  );
  expect((await pair()).status).toBe(403);
  const write = await callApi(wall, server, token, 'POST', '/api/auth/pairing-codes', {});
  expect(write.status).toBe(403);
  // A read names no origin, so it is judged by its token alone, as for any
  // client: revoking the device is what ends an extension's reads.
  expect((await callApi(wall, server, token, 'GET', '/api/settings')).status).toBe(200);
});

test('(d) a web page gains nothing from an allowed extension', async ({
  context,
  server,
  bystander,
  extensionId,
}) => {
  await allowWebCells(server, [extensionId]);
  const page = await context.newPage();
  await page.goto(bystander.origin);

  const outcome = await page.evaluate(async (base) => {
    const attempt = async (init: RequestInit): Promise<string> => {
      try {
        const response = await fetch(`${base}/api/meta`, init);
        return `${response.type} ${response.status}`;
      } catch (error) {
        return (error as Error).name;
      }
    };
    return {
      read: await attempt({}),
      opaque: await attempt({ mode: 'no-cors' }),
      write: await attempt({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    };
  }, server.base);

  // The browser gives the page no response: there is no CORS header to allow it.
  expect(outcome.read).toBe('TypeError');
  expect(outcome.write).toBe('TypeError');
  expect(outcome.opaque).not.toMatch(/^basic|^cors/);
});

test('(d) the extension page pairs, asks with a web slot, reads the stream and submits the answer', async ({
  server,
  vendor,
  extensionId,
  signInToVendor,
  openWall,
}) => {
  await server.detected();
  await allowWebCells(server, [extensionId]);
  await signInToVendor();
  const wall = await openWall();
  await expect(wall.frameLocator('#cell').getByTestId('chat')).toBeVisible();

  const token = await pairExtension(wall, server);
  const prompt = 'What is 2 + 2?';

  // Without the declaration the server refuses the web slot.
  const undeclared = await callApi(wall, server, token, 'POST', '/api/ask', {
    prompt,
    targets: [{ slotId: 'w1', providerId: 'web-claude' }],
  });
  expect(undeclared).toMatchObject({
    status: 400,
    json: { error: { code: 'web_client_required' } },
  });

  const created = await callApi(wall, server, token, 'POST', '/api/ask', {
    prompt,
    targets: [
      { slotId: 'w1', providerId: 'web-claude' },
      { slotId: 'c1', providerId: 'claude' },
    ],
    runsWebSlots: true,
  });
  expect(created.status).toBe(200);
  const { askId } = created.json as { askId: string };

  // The page follows the stream with fetch while the content script works in
  // the frame; the answer it reads is what the page submits.
  const run = await wall.evaluate(
    async ([base, bearer, id, text]) => {
      const streaming = window.wall.stream(base, bearer, `/api/ask/${id}/stream`);
      const answer = await window.wall.ask(text);
      const submitted = await window.wall.api(
        base,
        bearer,
        'POST',
        `/api/ask/${id}/slots/w1/result`,
        answer.ok
          ? { outcome: 'done', text: answer.text }
          : { outcome: 'failed', code: 'bad_output' },
      );
      return { answer, submitted, stream: await streaming };
    },
    [server.base, token, askId, prompt] as const,
  );

  expect(run.answer).toMatchObject({ ok: true, text: vendor.answerFor(prompt) });
  expect(run.submitted).toMatchObject({ status: 200, json: { status: 'done', truncated: false } });
  expect(vendor.prompts).toEqual([prompt]);

  // The stream was read to its terminal event, in more than one piece.
  expect(run.stream.status).toBe(200);
  expect(run.stream.chunks).toBeGreaterThan(1);
  const types = run.stream.events.map((event) => event.type);
  expect(types.at(-1)).toBe('ask_done');
  expect(types).toContain('delta');
  const sequence = run.stream.events.map((event) => event.seq);
  expect(sequence).toEqual(sequence.map((_, index) => index + 1));

  // Any other device finds the answer in the history, next to the CLI's.
  const stored = await server.finished(askId);
  expect(stored.slots.find((slot) => slot.slotId === 'w1')).toMatchObject({
    providerId: 'web-claude',
    status: 'done',
    text: vendor.answerFor(prompt),
    streaming: 'block',
  });
  expect(stored.slots.find((slot) => slot.slotId === 'c1')).toMatchObject({ status: 'done' });
  const history = await server.api<{ items: { askId: string }[] }>('GET', '/api/history');
  expect(history.json.items.map((item) => item.askId)).toContain(askId);

  // Sent again, the same result is accepted; a different one is not.
  const again = await callApi(wall, server, token, 'POST', `/api/ask/${askId}/slots/w1/result`, {
    outcome: 'done',
    text: vendor.answerFor(prompt),
  });
  expect(again.status).toBe(200);
  const other = await callApi(wall, server, token, 'POST', `/api/ask/${askId}/slots/w1/result`, {
    outcome: 'done',
    text: 'something else',
  });
  expect(other.status).toBe(409);
});

test('(d) a web slot cancelled from another device ends for the extension too', async ({
  server,
  extensionId,
  openWall,
}) => {
  await allowWebCells(server, [extensionId]);
  const wall = await openWall();
  const token = await pairExtension(wall, server);

  const created = await callApi(wall, server, token, 'POST', '/api/ask', {
    prompt: 'never answered',
    targets: [{ slotId: 'w1', providerId: 'web-claude' }],
    runsWebSlots: true,
  });
  const { askId } = created.json as { askId: string };
  const streaming = wall.evaluate(
    ([base, bearer, id]) => window.wall.stream(base, bearer, `/api/ask/${id}/stream`),
    [server.base, token, askId] as const,
  );

  // The test's own client is another device (the static token).
  const cancelled = await server.api('POST', `/api/ask/${askId}/cancel`, { slotId: 'w1' });
  expect(cancelled.json).toEqual({ cancelled: ['w1'] });

  const stream = await streaming;
  expect(stream.events.map((event) => event.type)).toEqual(['start', 'cancelled', 'ask_done']);
  const late = await callApi(wall, server, token, 'POST', `/api/ask/${askId}/slots/w1/result`, {
    outcome: 'done',
    text: 'too late',
  });
  expect(late.status).toBe(409);
  // Another device cannot submit for this ask at all.
  const forged = await server.api('POST', `/api/ask/${askId}/slots/w1/result`, {
    outcome: 'done',
    text: 'forged',
  });
  expect(forged.status).toBe(403);
});

test('the web UI runs as a page of the extension against a server on another origin', async ({
  context,
  server,
  extensionId,
}) => {
  await server.detected();
  await allowWebCells(server, [extensionId]);
  const errors: string[] = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    // A 401 is how the server says "not signed in".
    if (message.type() === 'error' && !/status of 401/.test(message.text())) {
      errors.push(message.text());
    }
  });
  const app = `chrome-extension://${extensionId}/app/index.html?server=${encodeURIComponent(server.base)}`;
  await page.goto(app);

  // Signed out: the sign-in page, with its route in the fragment.
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/sign-in');

  // Pair through the UI with a code, as on any other device.
  await page
    .getByLabel('Pairing code', { exact: true })
    .last()
    .fill(await server.mintPairingCode());
  await page.getByLabel('Device name').fill('Test extension');
  await signIn.click();
  await expect(page.getByRole('form', { name: 'Ask' })).toBeVisible();

  // The token is in the extension's storage, and no cookie was set for the server.
  const stored = await page.evaluate(() => chrome.storage.local.get('deviceToken'));
  expect(stored['deviceToken']).toMatch(/^[\w-]{40,}$/);
  expect(await context.cookies(server.base)).toEqual([]);

  // Ask the mock CLIs and watch an answer stream in.
  await expect(cells(page).first()).toBeVisible();
  await send(page, 'What is 2 + 2?');
  const finished = await server.finished(await currentAskId(page));
  const answered = finished.slots.find((slot) => slot.status === 'done' && slot.text !== '');
  expect(answered, 'a slot with an answer').toBeDefined();
  await expect(page.locator(`[data-slot-id="${answered?.slotId}"]`)).toContainText(
    (answered?.text ?? '').trim().slice(0, 12),
  );

  // Navigation stays inside the page; a reload keeps the route and the session.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/settings');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  const devices = page.getByRole('region', { name: 'Devices' });
  await expect(devices.getByRole('listitem')).toContainText('Test extension');
  await expect(devices.getByRole('listitem')).toContainText('This device');

  // Signing out revokes the device and forgets the token.
  await devices.getByRole('button', { name: 'Sign out' }).click();
  await expect(signIn).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.local.get('deviceToken'))).toEqual({});
  const left = await server.api<{ devices: unknown[] }>('GET', '/api/auth/devices');
  expect(left.json.devices).toEqual([]);

  expect(errors).toEqual([]);
});
