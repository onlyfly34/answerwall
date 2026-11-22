/**
 * The browser extension end to end: its own first-run page, the web UI as
 * its wall page, and web cells mixed with the cells the server runs. The
 * extension is the test build of `apps/extension` (the release code plus the
 * stand-in site), the server is the compiled one with the mock CLIs.
 */
import type { Page } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/manifest.mjs';
import type { TestServer } from '../support/server.ts';
import {
  arrange,
  cell,
  currentAskId,
  expectPhase,
  prompt as promptBox,
  send,
  sendButton,
  statusOf,
} from '../support/wall.ts';
import { SLOW_MARK } from '../web-cells/support/vendor-site.ts';
import { connectionOf, expect, framed, refused, test, WEB_PROVIDER } from './support/fixtures.ts';

const CLI = { slotId: 'c1', providerId: 'claude', model: 'mock-echo' };
const WEB = { slotId: 'w1', providerId: WEB_PROVIDER.id };

/** A wall with one cell the server runs and one web cell, the latter connected to its page. */
async function mixedWall(wall: Page, server: TestServer): Promise<void> {
  await arrange(wall, server, [CLI, WEB]);
  await expect(connectionOf(wall, WEB.slotId)).toHaveAttribute('data-connection', 'ready');
}

test('first run: the server refuses an extension it does not list; once listed, pairing connects the wall', async ({
  server,
  extensionId,
  worker,
  openWallPage,
  connect,
  allowExtension,
}) => {
  // The key in the manifest gives the unpacked extension the same ID everywhere.
  expect(extensionId).toBe(EXTENSION_ID);

  const wall = await openWallPage();
  await expect(wall.getByRole('heading', { level: 1 })).toHaveText(/Connect to your AnswerWall/);
  await expect(wall.getByTestId('extension-id')).toHaveText(extensionId);

  // Not listed on the server: no pairing, whatever the code.
  await wall.getByLabel('Server address').fill(server.base);
  await wall.getByLabel('Pairing code').fill(await server.mintPairingCode());
  await wall.getByRole('button', { name: 'Connect' }).click();
  await expect(wall.getByRole('alert')).toContainText('The server refuses this extension');
  expect(await worker.evaluate(() => chrome.storage.local.get('deviceToken'))).toEqual({});

  // Listed, but with a wrong code.
  await allowExtension({ fillPrompt: false, readAnswer: false });
  await wall.getByLabel('Pairing code').fill('000000');
  await wall.getByRole('button', { name: 'Connect' }).click();
  await expect(wall.getByRole('alert')).toContainText('pairing code is wrong');

  await connect(wall);
  await expect(wall.locator('#strip')).toContainText(`Server: ${server.base}`);
  const stored = await worker.evaluate(() => chrome.storage.local.get('deviceToken'));
  expect(stored['deviceToken']).toMatch(/^[\w-]{40,}$/);
  const devices = await server.api<{ devices: { name: string }[] }>('GET', '/api/auth/devices');
  expect(devices.json.devices.map((device) => device.name)).toContain('Browser extension');

  // The connection survives a reload; "Change server" returns to the first-run page.
  await wall.reload();
  await expect(wall.getByRole('form', { name: 'Ask' })).toBeVisible();
  wall.once('dialog', (dialog) => void dialog.accept());
  await wall.getByRole('button', { name: 'Change server' }).click();
  await expect(wall.getByTestId('extension-id')).toBeVisible();
  expect(await worker.evaluate(() => chrome.storage.local.get(['server', 'deviceToken']))).toEqual(
    {},
  );
  // The device was signed out on the server, not only forgotten here.
  const left = await server.api<{ devices: { name: string }[] }>('GET', '/api/auth/devices');
  expect(left.json.devices.map((device) => device.name)).not.toContain('Browser extension');
});

test('the content script in a tab of a site cannot read the server address or the device token', async ({
  context,
  vendor,
  worker,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await useStandIn();
  await allowExtension({ fillPrompt: false, readAnswer: false });
  const wall = await openWallPage();
  await connect(wall);
  const stored = await worker.evaluate(() => chrome.storage.local.get('deviceToken'));
  expect(stored['deviceToken']).toMatch(/^[\w-]{40,}$/);

  // An ordinary tab of the site: the content script runs there, in its own world.
  const tab = await context.newPage();
  const cdp = await context.newCDPSession(tab);
  const worlds: number[] = [];
  cdp.on('Runtime.executionContextCreated', ({ context: created }) => {
    const aux = created.auxData as { type?: string } | undefined;
    if (aux?.type === 'isolated' && created.origin.startsWith('chrome-extension://')) {
      worlds.push(created.id);
    }
  });
  await cdp.send('Runtime.enable');
  await tab.goto(vendor.origin);
  await expect.poll(() => worlds.length).toBeGreaterThan(0);
  const world = worlds.at(-1);
  if (world === undefined) throw new Error('The content script has no world in this tab');

  // Asked from that world, as a compromised page of the site could.
  const read = await cdp.send('Runtime.evaluate', {
    contextId: world,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.id) return 'not the content script';
      try {
        return 'read: ' + JSON.stringify(await chrome.storage.local.get(['server', 'deviceToken']));
      } catch (error) {
        return 'refused: ' + String(error);
      }
    })()`,
  });
  expect(read.result.value).toMatch(/^refused: /);
  expect(String(read.result.value)).not.toContain(String(stored['deviceToken']));
});

test('the wall page of the extension loads nothing from another site: no image, no form, no base', async ({
  vendor,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await allowExtension({ fillPrompt: false, readAnswer: false });
  const wall = await openWallPage();
  await connect(wall);

  // What markup that got past the sanitiser would try, put into the page directly.
  const blocked = await wall.evaluate(async (origin) => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(event.effectiveDirective);
    });
    const image = document.createElement('img');
    const settled = new Promise<string>((resolve) => {
      image.addEventListener('load', () => resolve('loaded'));
      image.addEventListener('error', () => resolve('blocked'));
    });
    image.src = `${origin}/probe-image.png`;
    document.body.append(image);
    const base = document.createElement('base');
    base.href = `${origin}/probe-base/`;
    document.head.append(base);
    const form = document.createElement('form');
    form.action = `${origin}/probe-form`;
    form.method = 'post';
    document.body.append(form);
    form.submit();
    const outcome = await settled;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outcome, violations: violations.sort(), baseURI: document.baseURI };
  }, vendor.origin);
  expect(blocked.outcome).toBe('blocked');
  expect(blocked.violations).toEqual(['base-uri', 'form-action', 'img-src']);
  expect(blocked.baseURI).toMatch(/^chrome-extension:\/\//);
  expect(wall.url()).toMatch(/^chrome-extension:\/\//);
  expect(vendor.requests.filter((request) => request.path.startsWith('/probe-'))).toEqual([]);
});

test('a mixed ask: the prompt is typed into the site, and its answer is stored next to the CLI answer', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);
  await expect(framed(wall, WEB.slotId).getByTestId('chat')).toBeVisible();
  // The cell names the site and offers the page in a tab of its own.
  await expect(cell(wall, WEB.slotId).getByRole('heading', { level: 3 })).toHaveText(
    WEB_PROVIDER.label,
  );
  await expect(
    cell(wall, WEB.slotId).getByRole('link', { name: `Open ${WEB_PROVIDER.label} in a tab` }),
  ).toHaveAttribute('href', `${vendor.origin}/`);

  const question = 'Which is larger, a kilobyte or a kibibyte?';
  await expect(sendButton(wall)).toHaveText('Send to 2');
  await send(wall, question);
  await expectPhase(wall, CLI.slotId, 'done');
  await expectPhase(wall, WEB.slotId, 'done');
  await expect(statusOf(wall, WEB.slotId)).toHaveText('Done. The answer is stored in history.');

  // The site got the prompt once, typed into its own page.
  expect(vendor.prompts).toEqual([question]);
  await expect(framed(wall, WEB.slotId).locator('.answer')).toHaveText(vendor.answerFor(question));

  // The history holds both answers; the web one is the text read from the page.
  const firstAsk = await currentAskId(wall);
  const stored = await server.finished(firstAsk);
  const web = stored.slots.find((slot) => slot.slotId === WEB.slotId);
  expect(web).toMatchObject({ status: 'done', text: vendor.answerFor(question) });
  expect(stored.slots.find((slot) => slot.slotId === CLI.slotId)?.status).toBe('done');

  // A second ask reads the new answer, not the first one again.
  const second = 'And a megabyte?';
  await send(wall, second);
  await expect.poll(() => currentAskId(wall)).not.toBe(firstAsk);
  const again = await server.finished(await currentAskId(wall));
  await expectPhase(wall, WEB.slotId, 'done');
  expect(again.slots.find((slot) => slot.slotId === WEB.slotId)?.text).toBe(
    vendor.answerFor(second),
  );

  // Opened from the history, the web cell shows the stored answer, not a frame.
  await wall.getByRole('navigation').getByRole('link', { name: 'History' }).click();
  await wall.getByRole('link', { name: 'Open' }).first().click();
  await expect(cell(wall, WEB.slotId).locator('.wall-markdown')).toHaveText(
    vendor.answerFor(second),
  );
  await expect(cell(wall, WEB.slotId).locator('iframe')).toHaveCount(0);
});

test('a rich editor is filled in too', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn('/?editor=rich');
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  await send(wall, 'Typed into a contenteditable element');
  await expectPhase(wall, WEB.slotId, 'done');
  expect(vendor.prompts).toEqual(['Typed into a contenteditable element']);
});

test('a rule that no longer matches: the slot fails without text, and the cell still works by hand', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  // The site after a redesign: the rule's selectors find nothing.
  await useStandIn('/?layout=changed');
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  await send(wall, 'Asked of a site that changed');
  await expectPhase(wall, CLI.slotId, 'done');
  // The rule waits a while for a page that may still be starting before it gives up.
  await expect(cell(wall, WEB.slotId)).toHaveAttribute('data-phase', 'error', { timeout: 30_000 });
  await expect(cell(wall, WEB.slotId).getByRole('alert')).toContainText(
    'The site rule did not find the message box',
  );
  expect(vendor.prompts).toEqual([]);
  const stored = await server.finished(await currentAskId(wall));
  expect(stored.slots.find((slot) => slot.slotId === WEB.slotId)).toMatchObject({
    status: 'error',
    text: '',
    error: { code: 'bad_output' },
  });

  // The page in the cell is untouched and answers a prompt typed by hand.
  const page = framed(wall, WEB.slotId);
  await page.getByLabel('Message').fill('Typed by hand');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.answer')).toHaveText(vendor.answerFor('Typed by hand'));
});

test('reading off: the prompt is typed in, the ask has no web slot and nothing of the page is stored', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: false });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  await send(wall, 'Filled in, not read');
  await expectPhase(wall, CLI.slotId, 'done');
  await expect(statusOf(wall, WEB.slotId)).toHaveText(
    'Sent in the page. Reading answers is off, so nothing is stored.',
  );
  await expect(framed(wall, WEB.slotId).locator('.answer')).toHaveText(
    vendor.answerFor('Filled in, not read'),
  );
  const stored = await server.finished(await currentAskId(wall));
  expect(stored.slots.map((slot) => slot.slotId)).toEqual([CLI.slotId]);
});

test('filling off: the user types in the page, and the finished answer is read and stored', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: false, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  await send(wall, 'Sent to the CLI cell only');
  await expectPhase(wall, CLI.slotId, 'done');
  await expect(statusOf(wall, WEB.slotId)).toHaveText(
    'Type and send the prompt in the page. The answer is read when it has finished.',
  );
  expect(vendor.prompts).toEqual([]);

  const page = framed(wall, WEB.slotId);
  await page.getByLabel('Message').fill('My own words');
  await page.getByRole('button', { name: 'Send' }).click();
  await expectPhase(wall, WEB.slotId, 'done');
  const stored = await server.finished(await currentAskId(wall));
  expect(stored.slots.find((slot) => slot.slotId === WEB.slotId)?.text).toBe(
    vendor.answerFor('My own words'),
  );
});

test('both switches off: a web cell is a page to use by hand and takes no part in an ask', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: false, readAnswer: false });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  await expect(statusOf(wall, WEB.slotId)).toHaveText(
    'Filling in and reading are off: use the page by hand.',
  );
  await expect(sendButton(wall)).toHaveText('Send to 1');
  await send(wall, 'For the CLI cell alone');
  await expectPhase(wall, CLI.slotId, 'done');
  await expectPhase(wall, WEB.slotId, 'idle');
  expect(vendor.prompts).toEqual([]);
  const stored = await server.finished(await currentAskId(wall));
  expect(stored.slots.map((slot) => slot.slotId)).toEqual([CLI.slotId]);

  // With nothing but the web cell on the wall there is nothing to send.
  await cell(wall, CLI.slotId)
    .getByRole('button', { name: /^Remove/ })
    .click();
  await promptBox(wall).fill('Nobody to ask');
  await expect(sendButton(wall)).toBeDisabled();
  await expect(wall.locator('#wall-composer-hint')).toContainText('Use them by hand');
});

test('cancelling a web cell ends its slot without an answer and leaves the page alone', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  const question = `${SLOW_MARK} A long answer`;
  await send(wall, question);
  await expect(statusOf(wall, WEB.slotId)).toHaveText('Waiting for the page to finish its answer…');
  await expect.poll(() => vendor.prompts).toEqual([question]);
  await cell(wall, WEB.slotId)
    .getByRole('button', { name: /^Cancel/ })
    .click();
  await expectPhase(wall, WEB.slotId, 'cancelled');

  const stored = await server.finished(await currentAskId(wall));
  expect(stored.slots.find((slot) => slot.slotId === WEB.slotId)).toMatchObject({
    status: 'cancelled',
    text: '',
  });
  // The page was not reloaded or stopped: its own answer keeps coming in.
  await expect(framed(wall, WEB.slotId).getByTestId('chat')).toBeVisible();
  await expect(framed(wall, WEB.slotId).locator('.answer')).toHaveAttribute(
    'data-state',
    'streaming',
  );
});

test('a second wall page with the same session, as a duplicated tab is, does not cancel the first page’s web slot', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  const question = `${SLOW_MARK} once`;
  await send(wall, question);
  await expect(statusOf(wall, WEB.slotId)).toHaveText('Waiting for the page to finish its answer…');
  const askId = await currentAskId(wall);

  // Chromium gives a duplicated tab a copy of the session storage. A test
  // cannot press "Duplicate", so the copy is made by hand: a second wall
  // page that starts with the first one's session storage.
  const session = await wall.evaluate(() => Object.entries(window.sessionStorage));
  const copy = await openWallPage();
  await copy.evaluate((entries) => {
    for (const [key, value] of entries) window.sessionStorage.setItem(key, String(value));
  }, session);
  await copy.reload();
  expect(await currentAskId(copy)).toBe(askId);
  await expectPhase(copy, WEB.slotId, 'waiting');

  // The copy watches. The slot keeps running and ends with the answer the first page read.
  await copy.waitForTimeout(1_500);
  const running = await server.snapshot(askId);
  expect(running.slots.find((slot) => slot.slotId === WEB.slotId)?.status).toBe('running');
  const stored = await server.finished(askId);
  expect(stored.slots.find((slot) => slot.slotId === WEB.slotId)).toMatchObject({
    status: 'done',
    text: vendor.answerFor(question),
  });
  await expectPhase(copy, WEB.slotId, 'done');
  // The prompt was typed once, by the first page.
  expect(vendor.prompts).toEqual([question]);
});

test('a reloaded wall page cancels its running web slot and does not type the prompt again', async ({
  server,
  vendor,
  signInToVendor,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
}) => {
  await signInToVendor();
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: true });
  const wall = await openWallPage();
  await connect(wall);
  await mixedWall(wall, server);

  const question = `${SLOW_MARK} once`;
  await send(wall, question);
  await expect(statusOf(wall, WEB.slotId)).toHaveText('Waiting for the page to finish its answer…');
  const askId = await currentAskId(wall);
  await wall.reload();

  const stored = await server.finished(askId);
  expect(stored.slots.find((slot) => slot.slotId === WEB.slotId)).toMatchObject({
    status: 'cancelled',
    text: '',
  });
  await expectPhase(wall, WEB.slotId, 'cancelled');
  expect(vendor.prompts).toEqual([question]);
});

test('signing in inside a cell works, and the header rule reaches no other tab or page', async ({
  context,
  server,
  vendor,
  bystander,
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
  sessionRules,
}) => {
  await useStandIn();
  await allowExtension({ fillPrompt: true, readAnswer: true });
  expect(await sessionRules()).toEqual([]);
  const wall = await openWallPage();
  // The first-run page frames nothing and installs no rule.
  expect(await sessionRules()).toEqual([]);
  await connect(wall);
  await arrange(wall, server, [CLI, WEB]);

  // Signed out: the cell shows the site's own sign-in page. Its form posts
  // and redirects inside the frame, a navigation the site starts itself.
  const page = framed(wall, WEB.slotId);
  await expect(page.getByTestId('signed-out')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('chat')).toBeVisible();
  await expect(connectionOf(wall, WEB.slotId)).toHaveAttribute('data-connection', 'ready');

  // Exactly one rule: this tab, sub-frames, the listed hosts.
  const rules = await sessionRules();
  expect(rules).toHaveLength(1);
  expect(rules[0]?.condition).toMatchObject({
    resourceTypes: ['sub_frame'],
    tabIds: [rules[0]?.id],
  });
  expect(rules[0]?.condition['requestDomains']).toContain('vendor.localhost');

  // A web page in another tab still cannot frame the site ...
  const other = await context.newPage();
  await other.goto(bystander.framing(vendor.origin));
  expect(await refused(other, '#cell')).toBe(true);
  // ... and an ordinary tab of the site still receives every header.
  const tab = await context.newPage();
  await tab.goto(vendor.origin);
  const seen = await tab.evaluate(async () => {
    const response = await fetch('/');
    return [
      response.headers.get('x-frame-options'),
      response.headers.get('content-security-policy'),
    ];
  });
  expect(seen[0]).toBe('DENY');
  expect(seen[1]).toContain("frame-ancestors 'none'");
  // The content script does nothing there: the page is as the site sent it.
  await expect(tab.getByTestId('chat')).toBeVisible();
  expect(vendor.prompts).toEqual([]);

  // The wall's own tab, sent to a web page: that page cannot frame the site
  // either, and the rule is gone.
  await wall.goto(bystander.framing(vendor.origin));
  expect(await refused(wall, '#cell')).toBe(true);
  await expect.poll(sessionRules).toEqual([]);
});

test('closing the wall tab removes its rule', async ({
  useStandIn,
  allowExtension,
  openWallPage,
  connect,
  sessionRules,
}) => {
  await useStandIn();
  await allowExtension({ fillPrompt: false, readAnswer: false });
  const wall = await openWallPage();
  await connect(wall);
  await expect.poll(async () => (await sessionRules()).length).toBe(1);
  await wall.close();
  await expect.poll(sessionRules).toEqual([]);
});
