import { expect, test } from '../support/fixtures.ts';
import {
  answer,
  arrange,
  cancelAllButton,
  cell,
  currentAskId,
  expectPhase,
  expectPhases,
  nav,
  send,
  sendButton,
  showCell,
} from '../support/wall.ts';

/** `w001 w002 …`: a missing or repeated piece shows in the text at once. */
const WORDS = Array.from({ length: 60 }, (_, index) => `w${String(index + 1).padStart(3, '0')} `);
const upTo = (count: number): string => WORDS.slice(0, count).join('').trim();

test.describe('resuming an ask', () => {
  test('a reload, a detour and a lost connection in mid-stream lose and repeat nothing', async ({
    page,
    signIn,
    server,
    stub,
    link,
    guard,
    device,
  }) => {
    guard.allowConsole(/net::ERR_/);
    stub.script('count', { chunks: WORDS, holdAt: [20, 40] });
    await server.setProviders({}, [stub.instance({ concurrency: 2 })]);
    // The browser reaches the server through a relay the test can cut.
    await signIn();
    await page.goto(`${link.origin}/`);
    await arrange(page, server, [
      { slotId: 'o1', providerId: 'stub' },
      { slotId: 'o2', providerId: 'stub' },
      { slotId: 'c1', providerId: 'claude', model: 'mock-echo' },
    ]);
    await send(page, 'Count to sixty');
    await stub.held('count', 2);
    await expectPhases(page, { o1: 'streaming', o2: 'streaming', c1: 'done' });
    await expect(answer(page, 'o1')).toHaveText(upTo(20));
    const askId = await currentAskId(page);

    // 1. Reload: the page picks its ask up again and shows exactly what was received.
    await page.reload();
    await expectPhases(page, { o1: 'streaming', o2: 'streaming', c1: 'done' });
    await expect(answer(page, 'o1')).toHaveText(upTo(20));
    await expect(cancelAllButton(page)).toBeVisible();
    await expect(sendButton(page)).toBeDisabled();
    await expect(page.locator('.wall-asked-text')).toHaveText('Count to sixty');

    stub.release('count');
    await stub.held('count', 2);
    await expect(answer(page, 'o1')).toHaveText(upTo(40));

    // 2. Another page of the app and back: still the same ask, still exact.
    await nav(page, 'History').click();
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
    await nav(page, 'Wall').click();
    await expectPhase(page, 'o1', 'streaming');
    await expect(answer(page, 'o1')).toHaveText(upTo(40));

    // 3. The connection drops while the server keeps going to the end.
    link.sever();
    await expect(page.locator('.wall-notice')).toHaveText('Connection lost. Reconnecting…');
    stub.release('count');
    const final = await server.finished(askId);
    expect(final.slots.map((slot) => slot.status)).toEqual(['done', 'done', 'done']);
    // The page has not heard of it yet.
    await expectPhase(page, 'o1', 'streaming');
    await expect(answer(page, 'o1')).toHaveText(upTo(40));

    link.restore();
    await expectPhases(page, { o1: 'done', o2: 'done', c1: 'done' });
    await expect(page.locator('.wall-notice')).toBeHidden();
    await expect(sendButton(page)).toBeDisabled(); // no prompt typed
    await expect(cancelAllButton(page)).toBeHidden();

    // Every piece exactly once, in order, in both cells, and equal to the server's record.
    for (const slotId of ['o1', 'o2']) {
      await showCell(page, device, slotId);
      await expect(answer(page, slotId)).toHaveText(upTo(60));
      expect(final.slots.find((slot) => slot.slotId === slotId)?.text).toBe(WORDS.join(''));
    }
    await showCell(page, device, 'c1');
    await expect(answer(page, 'c1')).toHaveText('You said: Count to sixty');

    // A reload after the end shows the finished ask from the server's record.
    await page.reload();
    await expectPhases(page, { o1: 'done', o2: 'done', c1: 'done' });
    await showCell(page, device, 'o2');
    await expect(answer(page, 'o2')).toHaveText(upTo(60));
    // One request per cell reached the endpoint: nothing was re-run to resume.
    expect(stub.requests('count')).toBe(2);
  });

  test('a running ask opened from History in another tab is followed live', async ({
    wallPage: page,
    context,
    server,
    stub,
  }) => {
    stub.script('count', { chunks: WORDS, holdAt: [30] });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [{ slotId: 'o1', providerId: 'stub' }]);
    await send(page, 'Count in two tabs');
    await stub.held('count', 1);
    await expect(answer(page, 'o1')).toHaveText(upTo(30));

    const other = await context.newPage();
    await other.goto('/history');
    await other.getByRole('link', { name: 'Count in two tabs' }).click();
    await expect(other.getByRole('status').filter({ hasText: 'read-only' })).toBeVisible();
    await expectPhase(other, 'o1', 'streaming');
    await expect(answer(other, 'o1')).toHaveText(upTo(30));

    stub.release('count');
    for (const tab of [page, other]) {
      await expectPhase(tab, 'o1', 'done');
      await expect(answer(tab, 'o1')).toHaveText(upTo(60));
    }
    expect(stub.requests('count')).toBe(1);
  });

  test('closing the page does not cancel the ask', async ({
    wallPage: page,
    context,
    server,
    stub,
  }) => {
    stub.script('count', { chunks: WORDS, holdAt: [10] });
    await server.setProviders({}, [stub.instance()]);
    await arrange(page, server, [{ slotId: 'o1', providerId: 'stub' }]);
    await send(page, 'Keep going without me');
    await stub.held('count', 1);
    const askId = await currentAskId(page);
    await page.close();

    stub.release('count');
    const final = await server.finished(askId);
    expect(final.slots[0]).toMatchObject({ status: 'done', text: WORDS.join('') });

    const later = await context.newPage();
    await later.goto(`/?ask=${askId}`);
    await expectPhase(later, 'o1', 'done');
    await expect(cell(later, 'o1').locator('.wall-markdown')).toHaveText(upTo(60));
  });
});
