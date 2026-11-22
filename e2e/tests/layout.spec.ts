import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.ts';
import type { AskTarget } from '../support/server.ts';
import { swipe } from '../support/touch.ts';
import {
  arrange,
  cell,
  cells,
  columnCount,
  currentAskId,
  expectPhase,
  nav,
  presetBar,
  send,
  slotOrder,
} from '../support/wall.ts';

const SIX: AskTarget[] = [
  { slotId: 'a', providerId: 'claude' },
  { slotId: 'b', providerId: 'codex' },
  { slotId: 'c', providerId: 'grok' },
  { slotId: 'd', providerId: 'claude', model: 'haiku' },
  { slotId: 'e', providerId: 'codex' },
  { slotId: 'f', providerId: 'grok' },
];

const layout = (page: Page): Locator => page.getByRole('group', { name: 'Layout' });
const grid = (page: Page): Locator => page.getByTestId('wall-grid');

/** The number of columns that fit the grid at a minimum cell width. */
function fitting(page: Page, minWidth: number): Promise<number> {
  return grid(page).evaluate((element, min) => {
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    return Math.max(1, Math.floor((element.clientWidth + gap) / (min + gap)));
  }, minWidth);
}

test.describe('layout on a desktop @desktop', () => {
  test('columns follow the minimum width or a fixed count', async ({ wallPage: page, server }) => {
    await arrange(page, server, SIX);
    await expect(page.locator('.wall')).toHaveAttribute('data-viewport', 'desktop');

    // Automatic: as many columns as fit the minimum width of the settings (360 px).
    await expect(layout(page).getByLabel('Columns')).toHaveValue('auto');
    await expect(layout(page).getByLabel('Minimum width (px)')).toHaveValue('360');
    expect(await columnCount(page)).toBe(await fitting(page, 360));
    await expect(layout(page).getByRole('button', { name: 'Reset layout' })).toHaveCount(0);

    for (const width of [600, 240]) {
      await layout(page).getByLabel('Minimum width (px)').fill(String(width));
      await layout(page).getByLabel('Minimum width (px)').press('Enter');
      await expect.poll(() => columnCount(page)).toBe(await fitting(page, width));
    }
    expect(await fitting(page, 600)).toBeLessThan(await fitting(page, 240));
    // No cell is narrower than asked for.
    const narrowest = await cells(page).evaluateAll((elements) =>
      Math.min(...elements.map((element) => element.getBoundingClientRect().width)),
    );
    expect(narrowest).toBeGreaterThanOrEqual(240);

    // A value outside the range is brought back into it.
    await layout(page).getByLabel('Minimum width (px)').fill('5');
    await layout(page).getByLabel('Minimum width (px)').press('Enter');
    const clamped = Number(await layout(page).getByLabel('Minimum width (px)').inputValue());
    expect(clamped).toBeGreaterThan(5);

    // Fixed: exactly that many columns, whatever fits.
    await layout(page).getByLabel('Columns').selectOption('fixed');
    await expect(layout(page).getByLabel('Count')).toHaveValue('3');
    await expect.poll(() => columnCount(page)).toBe(3);
    for (const count of [5, 1, 2]) {
      await layout(page).getByLabel('Count').fill(String(count));
      await layout(page).getByLabel('Count').press('Enter');
      await expect.poll(() => columnCount(page)).toBe(count);
    }
    const rows = await cells(page).evaluateAll(
      (elements) =>
        new Set(elements.map((element) => Math.round(element.getBoundingClientRect().top))).size,
    );
    expect(rows).toBe(3);

    // The choice belongs to this device's session: it survives a reload…
    await page.reload();
    await expect(layout(page).getByLabel('Count')).toHaveValue('2');
    expect(await columnCount(page)).toBe(2);

    // …and Reset returns to the shared settings.
    await layout(page).getByRole('button', { name: 'Reset layout' }).click();
    await expect(layout(page).getByLabel('Columns')).toHaveValue('auto');
    await expect.poll(() => columnCount(page)).toBe(await fitting(page, 360));
  });

  test('the shared layout settings and a preset layout apply to the wall', async ({
    wallPage: page,
    server,
  }) => {
    await arrange(page, server, SIX);

    // The default for every device, from the settings page.
    await nav(page, 'Settings').click();
    const section = page.getByRole('region', { name: 'Wall layout' });
    const stored = async (): Promise<unknown> =>
      (await server.api<{ settings: { layout: unknown } }>('GET', '/api/settings')).json.settings
        .layout;
    await section.getByLabel('A fixed number').check();
    // Each change is saved on its own; the next one waits for this one to land.
    await expect.poll(stored).toMatchObject({ mode: 'fixed' });
    await section.getByLabel('Number of columns').fill('4');
    await section.getByLabel('Number of columns').blur();
    await expect.poll(stored).toMatchObject({ mode: 'fixed', columns: 4 });
    await nav(page, 'Wall').click();
    await expect.poll(() => columnCount(page)).toBe(4);
    await expect(layout(page).getByLabel('Count')).toHaveValue('4');

    // A preset saved with its own layout brings it along.
    await layout(page).getByLabel('Count').fill('2');
    await layout(page).getByLabel('Count').press('Enter');
    await presetBar(page).getByRole('button', { name: 'Save as preset' }).click();
    await presetBar(page).getByLabel('Preset name').fill('Two wide');
    await presetBar(page).getByLabel('Preset name').press('Enter');
    await expect(presetBar(page).getByRole('button', { name: 'Two wide' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await presetBar(page).getByRole('button', { name: 'Test wall' }).click();
    await expect.poll(() => columnCount(page)).toBe(4);
    await presetBar(page).getByRole('button', { name: 'Two wide' }).click();
    await expect.poll(() => columnCount(page)).toBe(2);
  });

  test('one cell is maximised and restored', async ({ wallPage: page, server }) => {
    await arrange(page, server, SIX);
    await expect(cells(page).filter({ visible: true })).toHaveCount(6);

    await cell(page, 'c').getByRole('button', { name: 'Maximise Grok' }).click();
    await expect(cell(page, 'c')).toHaveClass(/wall-cell-maximised/);
    await expect(cells(page).filter({ visible: true })).toHaveCount(1);
    expect(await columnCount(page)).toBe(1);
    const widths = await page.evaluate(() => ({
      cell: document.querySelector('.wall-cell-maximised')?.getBoundingClientRect().width ?? 0,
      grid: document.querySelector('[data-testid="wall-grid"]')?.getBoundingClientRect().width ?? 1,
    }));
    expect(widths.cell).toBeGreaterThan(widths.grid * 0.95);

    // An ask still goes to every cell, and the maximised one shows its answer.
    await send(page, 'Maximised');
    for (const slot of SIX) await expectPhase(page, slot.slotId, 'done');
    await expect(cell(page, 'c').locator('.wall-markdown')).toHaveText('Hello from the mock CLI.');

    // The maximised cell is remembered across a reload.
    await page.reload();
    await expect(cells(page).filter({ visible: true })).toHaveCount(1);
    await expect(cell(page, 'c')).toBeVisible();

    const restore = cell(page, 'c').getByRole('button', { name: 'Restore Grok' });
    await expect(restore).toHaveAttribute('aria-pressed', 'true');
    await restore.click();
    await expect(cells(page).filter({ visible: true })).toHaveCount(6);
    await expect(cell(page, 'c')).not.toHaveClass(/wall-cell-maximised/);
  });

  test('cells are reordered by dragging and with the keyboard', async ({
    wallPage: page,
    server,
  }) => {
    await arrange(page, server, SIX);
    await layout(page).getByLabel('Columns').selectOption('fixed');
    await expect.poll(() => columnCount(page)).toBe(3);
    expect(await slotOrder(page)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const handle = (slotId: string): Locator => cell(page, slotId).locator('.wall-cell-handle');
    const centre = async (target: Locator) => {
      const box = await target.boundingBox();
      if (!box) throw new Error('The element has no box');
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    // Drag the first cell onto the third.
    const start = await centre(handle('a'));
    const end = await centre(cell(page, 'c'));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await expect(cell(page, 'a')).toHaveClass(/wall-cell-dragging/);
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await expect.poll(() => slotOrder(page)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);
    await page.mouse.up();
    await expect(cell(page, 'a')).not.toHaveClass(/wall-cell-dragging/);
    await expect(grid(page)).not.toHaveClass(/wall-grid-dragging/);
    expect(await slotOrder(page)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);

    // The keyboard does the same from the handle, and says what happened.
    await handle('f').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => slotOrder(page)).toEqual(['b', 'c', 'a', 'd', 'f', 'e']);
    await expect(handle('f')).toBeFocused();
    await expect(page.locator('.wall-grid-area [aria-live="polite"]')).toHaveText(
      'Grok moved to position 5 of 6',
    );
    await page.keyboard.press('Home');
    await expect.poll(() => slotOrder(page)).toEqual(['f', 'b', 'c', 'a', 'd', 'e']);
    await page.keyboard.press('End');
    await expect.poll(() => slotOrder(page)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);
    await expect(handle('f')).toHaveAccessibleName('Move Grok, position 6 of 6');

    // The order on the wall is the order of the ask, and it survives a reload.
    await send(page, 'In this order');
    for (const slot of SIX) await expectPhase(page, slot.slotId, 'done');
    const snapshot = await server.snapshot(await currentAskId(page));
    expect(snapshot.slots.map((slot) => slot.slotId)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);
    await page.reload();
    await expect.poll(() => slotOrder(page)).toEqual(['b', 'c', 'a', 'd', 'e', 'f']);
  });
});

test.describe('layout on a tablet @tablet', () => {
  test('the wall has two columns by default', async ({ wallPage: page, server }) => {
    await arrange(page, server, SIX);
    await expect(page.locator('.wall')).toHaveAttribute('data-viewport', 'tablet');
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(cells(page).filter({ visible: true })).toHaveCount(6);

    expect(await columnCount(page)).toBe(2);
    await expect(layout(page).getByLabel('Columns')).toHaveValue('fixed');
    await expect(layout(page).getByLabel('Count')).toHaveValue('2');
    const lefts = await cells(page).evaluateAll(
      (elements) =>
        [...new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left)))]
          .length,
    );
    expect(lefts).toBe(2);
    // Nothing is wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      820,
    );

    // It is a default, not a limit.
    await layout(page).getByLabel('Count').fill('3');
    await layout(page).getByLabel('Count').press('Enter');
    await expect.poll(() => columnCount(page)).toBe(3);
    await layout(page).getByRole('button', { name: 'Reset layout' }).click();
    await expect.poll(() => columnCount(page)).toBe(2);

    // Turned to landscape past the breakpoint, the wall lays out like a desktop.
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('.wall')).toHaveAttribute('data-viewport', 'desktop');
    await expect.poll(() => columnCount(page)).toBe(await fitting(page, 360));
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect.poll(() => columnCount(page)).toBe(2);
  });

  test('cells are maximised with a tap', async ({ wallPage: page, server }) => {
    await arrange(page, server, SIX);
    await cell(page, 'b').getByRole('button', { name: 'Maximise Codex' }).tap();
    await expect(cells(page).filter({ visible: true })).toHaveCount(1);
    await cell(page, 'b').getByRole('button', { name: 'Restore Codex' }).tap();
    await expect(cells(page).filter({ visible: true })).toHaveCount(6);
  });
});

test.describe('layout on a phone @phone', () => {
  const TWELVE: AskTarget[] = Array.from({ length: 12 }, (_, index) => ({
    slotId: `s${index + 1}`,
    providerId: ['claude', 'codex', 'grok'][index % 3] ?? 'claude',
  }));
  const tabs = (page: Page): Locator =>
    page.getByRole('tablist', { name: 'Cells' }).getByRole('tab');
  const dots = (page: Page): Locator =>
    page.getByRole('group', { name: 'Status of every cell' }).getByRole('button');
  const shown = async (page: Page): Promise<string | null> =>
    cells(page).filter({ visible: true }).getAttribute('data-slot-id');
  const dotLabels = (page: Page): Promise<(string | null)[]> =>
    dots(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('aria-label')),
    );
  /** The vertical middle of a part of the cell that is on screen. */
  async function swipeHeight(page: Page, part: string): Promise<number> {
    const box = await cells(page).filter({ visible: true }).locator(part).boundingBox();
    if (!box) throw new Error(`${part} has no box`);
    return box.y + box.height / 2;
  }
  /** One finger across the given part of the visible cell, towards the left or the right. */
  async function swipeAcross(page: Page, part: string, towards: 'left' | 'right'): Promise<void> {
    const y = await swipeHeight(page, part);
    const [from, to] = towards === 'left' ? [330, 60] : [60, 330];
    await swipe(page, { x: from, y }, { x: to, y });
  }

  test('one cell at a time, changed by swiping, tabs and status dots', async ({
    wallPage: page,
    server,
  }) => {
    await arrange(page, server, TWELVE);
    await expect(page.locator('.wall')).toHaveAttribute('data-viewport', 'phone');
    await expect(layout(page)).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(12);
    await expect(dots(page)).toHaveCount(12);
    await expect(cells(page).filter({ visible: true })).toHaveCount(1);
    expect(await shown(page)).toBe('s1');
    await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(cell(page, 's1')).toHaveAttribute('role', 'tabpanel');
    // No grid controls on a single cell.
    await expect(cell(page, 's1').locator('.wall-cell-handle')).toHaveCount(0);
    await expect(cell(page, 's1').getByRole('button', { name: /^Maximise/ })).toHaveCount(0);
    // The page itself never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    // The finger travels across the cell's status line, outside the scrolling answer.
    await swipeAcross(page, '.wall-cell-statusbar', 'left');
    await expect.poll(() => shown(page)).toBe('s2');
    await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(dots(page).nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(dots(page).nth(0)).not.toHaveAttribute('aria-current', 'true');
    await swipeAcross(page, '.wall-cell-statusbar', 'left');
    await expect.poll(() => shown(page)).toBe('s3');
    await swipeAcross(page, '.wall-cell-statusbar', 'right');
    await expect.poll(() => shown(page)).toBe('s2');

    // Before the first cell there is nothing to swipe to.
    await swipeAcross(page, '.wall-cell-statusbar', 'right');
    await expect.poll(() => shown(page)).toBe('s1');
    await swipeAcross(page, '.wall-cell-statusbar', 'right');
    expect(await shown(page)).toBe('s1');

    // The tab row scrolls; choosing the last cell brings its tab into view.
    const overflow = await page
      .getByRole('tablist')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(true);
    await dots(page).nth(11).tap();
    await expect.poll(() => shown(page)).toBe('s12');
    await expect(tabs(page).nth(11)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page).nth(11)).toBeInViewport();
    // After the last cell there is nothing either.
    await swipeAcross(page, '.wall-cell-statusbar', 'left');
    expect(await shown(page)).toBe('s12');
    await tabs(page).nth(10).tap();
    await expect.poll(() => shown(page)).toBe('s11');

    // A short or a mostly vertical movement is not a swipe.
    const y = await swipeHeight(page, '.wall-cell-statusbar');
    await swipe(page, { x: 200, y }, { x: 170, y });
    await swipe(page, { x: 200, y }, { x: 150, y: y + 100 });
    await page.waitForTimeout(250);
    expect(await shown(page)).toBe('s11');
  });

  test('a swipe across the answer itself changes the cell', async ({ wallPage: page, server }) => {
    await arrange(page, server, TWELVE.slice(0, 3));
    await send(page, 'Swipe over me');
    for (const slot of TWELVE.slice(0, 3)) await expectPhase(page, slot.slotId, 'done');
    await expect(cell(page, 's1').locator('.wall-markdown')).toHaveText('Hello from the mock CLI.');

    // The answer is most of the cell, so this is where a thumb lands.
    await swipeAcross(page, '.wall-cell-body', 'left');
    await expect.poll(() => shown(page), { timeout: 3000 }).toBe('s2');
    await swipeAcross(page, '.wall-cell-body', 'right');
    await expect.poll(() => shown(page), { timeout: 3000 }).toBe('s1');
  });

  test('the status dots follow every cell of a running ask', async ({ wallPage: page, server }) => {
    await server.setProviders({ claude: { concurrency: 1 } });
    await arrange(page, server, [
      { slotId: 'h', providerId: 'claude', model: 'mock-hang' },
      { slotId: 'q', providerId: 'claude' },
      { slotId: 'd', providerId: 'grok' },
      { slotId: 'e', providerId: 'codex', model: 'mock-quota' },
    ]);
    await expect
      .poll(() => dotLabels(page))
      .toEqual(['Claude: no answer', 'Claude: no answer', 'Grok: no answer', 'Codex: no answer']);

    await send(page, 'Dots');
    await expect
      .poll(() => dotLabels(page))
      .toEqual(['Claude: waiting', 'Claude: queued', 'Grok: done', 'Codex: error']);
    await expect(dots(page).nth(0).locator('.wall-dot')).toHaveAttribute('data-phase', 'waiting');
    await expect(dots(page).nth(3).locator('.wall-dot')).toHaveAttribute('data-phase', 'error');

    // A dot leads to its cell, where the failure is explained.
    await dots(page).nth(3).tap();
    await expect(cell(page, 'e').getByRole('alert')).toContainText(
      'The quota of this provider is used up.',
    );

    await page.getByRole('button', { name: 'Cancel all' }).tap();
    await expect
      .poll(() => dotLabels(page))
      .toEqual(['Claude: cancelled', 'Claude: cancelled', 'Grok: done', 'Codex: error']);
  });
});
