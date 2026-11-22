/**
 * The mechanism of web cells (docs/DECISIONS.md §11, docs/web-cells.md),
 * proven in a real Chromium with an unpacked Manifest V3 extension against a
 * stand-in vendor site that refuses framing and signs in with a
 * `SameSite=Lax; HttpOnly` cookie. No real site is ever contacted.
 */
import type { Frame, Page } from '@playwright/test';
import { expect, test } from './support/fixtures.ts';
import { PROBE_COOKIE, SESSION_COOKIE, STRICT_COOKIE } from './support/vendor-site.ts';

const cell = (page: Page) => page.frameLocator('#cell');

/** The frame element's own frame, once it has finished (or failed) loading. */
async function cellFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('#cell').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('the cell has no frame');
  await frame.waitForLoadState('load').catch(() => undefined);
  return frame;
}

/** Whether the cell shows a page of the stand-in site, or the browser's refusal. */
async function refused(page: Page): Promise<boolean> {
  const frame = await cellFrame(page);
  return frame.url().startsWith('chrome-error://');
}

for (const blockThirdPartyCookies of [false, true]) {
  test.describe(`third-party cookies ${blockThirdPartyCookies ? 'blocked' : 'allowed'}`, () => {
    test.use({ blockThirdPartyCookies });

    test('the profile setting is in effect (control)', async ({
      context,
      vendor,
      bystander,
      signInToVendor,
    }) => {
      await signInToVendor();
      const page = await context.newPage();
      await page.goto(bystander.framing(`${vendor.origin}/framable`));
      const sent = await cell(page).getByTestId('cookies').textContent();
      // A cross-site frame under a web page never gets the Lax cookie; it
      // gets the SameSite=None one unless third-party cookies are blocked.
      expect(sent).toBe(blockThirdPartyCookies ? '(none)' : PROBE_COOKIE);
    });

    test('(a) the extension page frames the site; nothing else is changed', async ({
      context,
      vendor,
      bystander,
      signInToVendor,
      openWall,
    }) => {
      const tab = await signInToVendor();

      // Without the rule the browser refuses, as the site asks.
      const bare = await openWall({ rule: 'none' });
      expect(await refused(bare)).toBe(true);
      await bare.close();

      const wall = await openWall();
      await expect(cell(wall).getByTestId('chat')).toBeVisible();
      const rules = await wall.evaluate(() => window.wall.sessionRules());
      expect(rules).toHaveLength(1);
      expect(rules[0]?.condition).toMatchObject({
        requestDomains: ['vendor.localhost'],
        resourceTypes: ['sub_frame'],
      });

      // While that wall is open, a web page in another tab still cannot frame the site.
      const hostile = await context.newPage();
      await hostile.goto(bystander.framing(vendor.origin));
      expect(await refused(hostile)).toBe(true);

      // Requests other than the frame's own document keep their headers, in
      // the wall's tab (seen from inside the frame) and in an ordinary tab.
      const headersSeenBy = (target: Page | Frame) =>
        target.evaluate(async () => {
          const response = await fetch('/');
          return [
            response.headers.get('x-frame-options'),
            response.headers.get('content-security-policy'),
          ];
        });
      const inFrame = await headersSeenBy(await cellFrame(wall));
      const inTab = await headersSeenBy(tab);
      for (const [xfo, csp] of [inFrame, inTab]) {
        expect(xfo).toBe('DENY');
        expect(csp).toContain("frame-ancestors 'none'");
      }

      // Closing the wall removes its rule.
      await wall.close();
      const again = await openWall({ rule: 'none' });
      await expect
        .poll(() => again.evaluate(() => window.wall.sessionRules()).then((list) => list.length))
        .toBe(0);
    });

    test('(a) a navigation the site starts inside the frame needs the tab-scoped rule', async ({
      vendor,
      openWall,
    }) => {
      // Signed out: the frame shows the sign-in form, and submitting it is a
      // sub-frame navigation whose initiator is the site, not the extension.
      const byInitiator = await openWall({ rule: 'initiator' });
      await expect(cell(byInitiator).getByTestId('signed-out')).toBeVisible();
      await cell(byInitiator).getByRole('button', { name: 'Sign in' }).click();
      await expect.poll(() => refused(byInitiator)).toBe(true);
      await byInitiator.close();

      const byTab = await openWall({ rule: 'tab' });
      // The first attempt did sign in (the response set the cookie) although its page was refused.
      await expect(cell(byTab).getByTestId('chat')).toBeVisible();
      const before = vendor.requests.length;
      await (await cellFrame(byTab)).evaluate(() => location.reload());
      await expect(cell(byTab).getByTestId('chat')).toBeVisible();
      expect(vendor.requests.length).toBeGreaterThan(before);
    });

    test('(b) the session cookie of a normal tab is sent inside the frame', async ({
      context,
      vendor,
      signInToVendor,
      openWall,
    }) => {
      const tab = await signInToVendor();
      const cookiesBefore = await context.cookies(vendor.origin);
      vendor.requests.length = 0;

      const wall = await openWall();
      await expect(cell(wall).getByTestId('chat')).toBeVisible();

      const document = vendor.requests.find((request) => request.secFetchDest === 'iframe');
      expect(document, 'the frame document request').toBeDefined();
      expect(document?.cookies).toContain(SESSION_COOKIE);
      // A SameSite=Strict cookie travels too: under the extension's page the
      // frame counts as the site's own context.
      expect(document?.cookies).toContain(STRICT_COOKIE);
      test.info().annotations.push({
        type: 'frame document request',
        description: JSON.stringify(document),
      });

      // Requests the framed page makes itself carry it too.
      const answer = await wall.evaluate(() => window.wall.ask('cookie check'));
      expect(answer.ok).toBe(true);
      const chat = vendor.requests.find((request) => request.path === '/api/chat');
      expect(chat?.cookies).toContain(SESSION_COOKIE);
      test.info().annotations.push({ type: 'chat request', description: JSON.stringify(chat) });

      // Storage is the site's own too, not a partition of the wall: what an
      // ordinary tab stored is what the frame reads.
      await tab.evaluate(() => localStorage.setItem('vendor-setting', 'from the tab'));
      const stored = await (
        await cellFrame(wall)
      ).evaluate(() => localStorage.getItem('vendor-setting'));
      expect(stored).toBe('from the tab');

      // The extension touched no cookie: same names, values and attributes as before.
      expect(await context.cookies(vendor.origin)).toEqual(cookiesBefore);
      const session = cookiesBefore.find((cookie) => cookie.name === SESSION_COOKIE);
      expect(session).toMatchObject({ sameSite: 'Lax', httpOnly: true });
    });

    test('(b) signing in inside the frame works too', async ({ vendor, openWall }) => {
      const wall = await openWall();
      await expect(cell(wall).getByTestId('signed-out')).toBeVisible();
      await cell(wall).getByRole('button', { name: 'Sign in' }).click();
      await expect(cell(wall).getByTestId('chat')).toBeVisible();
      const answer = await wall.evaluate(() => window.wall.ask('signed in inside the frame'));
      expect(answer).toMatchObject({
        ok: true,
        text: vendor.answerFor('signed in inside the frame'),
      });
    });

    for (const editor of ['plain', 'rich'] as const) {
      test(`(c) the content script fills, submits and reads the answer (${editor} input)`, async ({
        vendor,
        signInToVendor,
        openWall,
      }) => {
        await signInToVendor();
        const wall = await openWall({ path: editor === 'rich' ? '/?editor=rich' : '/' });
        await expect(cell(wall).getByTestId('chat')).toBeVisible();

        const prompt = `What is 2 + 2? (${editor})`;
        const answer = await wall.evaluate((text) => window.wall.ask(text), prompt);
        expect(answer.ok).toBe(true);
        expect(answer.text).toBe(vendor.answerFor(prompt));
        expect(vendor.prompts).toEqual([prompt]);
        await expect(cell(wall).locator('.answer')).toHaveAttribute('data-state', 'done');
      });
    }

    test('(c) the content script is inert outside the wall', async ({
      context,
      vendor,
      bystander,
      signInToVendor,
      openWall,
    }) => {
      const tab = await signInToVendor();
      const wall = await openWall();
      await expect(cell(wall).locator('html')).toHaveAttribute('data-web-cell', 'active');
      expect(await wall.evaluate(() => window.wall.activeFrames())).toBe(1);

      // An ordinary tab of the site, and the site framed by a web page.
      await tab.reload();
      await expect(tab.getByTestId('chat')).toBeVisible();
      await expect(tab.locator('html')).not.toHaveAttribute('data-web-cell');
      const hostile = await context.newPage();
      await hostile.goto(bystander.framing(`${vendor.origin}/framable`));
      await expect(cell(hostile).getByTestId('cookies')).toBeVisible();
      await expect(cell(hostile).locator('html')).not.toHaveAttribute('data-web-cell');
      expect(await wall.evaluate(() => window.wall.activeFrames())).toBe(1);
      expect(vendor.prompts).toEqual([]);
    });
  });
}
