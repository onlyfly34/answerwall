/** Page helpers for the wall: cells, presets, the composer. */
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AskTarget, TestServer } from './server.ts';
import type { Viewport } from './fixtures.ts';

export type Phase =
  'idle' | 'queued' | 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled' | 'timeout';

export const cells = (page: Page): Locator => page.locator('article.wall-cell');

export const cell = (page: Page, slotId: string): Locator =>
  page.locator(`article.wall-cell[data-slot-id="${slotId}"]`);

/** The rendered answer of a cell. */
export const answer = (page: Page, slotId: string): Locator =>
  cell(page, slotId).locator('.wall-markdown');

export const statusOf = (page: Page, slotId: string): Locator =>
  cell(page, slotId).locator('.wall-cell-status');

export const prompt = (page: Page): Locator => page.locator('#wall-prompt');

export const sendButton = (page: Page): Locator =>
  page.locator('form.wall-composer button[type="submit"]');

export const cancelAllButton = (page: Page): Locator =>
  page.getByRole('form', { name: 'Ask' }).getByRole('button', { name: 'Cancel all' });

export const presetBar = (page: Page): Locator => page.getByRole('region', { name: 'Presets' });

export const nav = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('navigation').getByRole('link', { name });

export async function expectPhase(page: Page, slotId: string, phase: Phase): Promise<void> {
  await expect(cell(page, slotId), `phase of ${slotId}`).toHaveAttribute('data-phase', phase);
}

export async function expectPhases(page: Page, phases: Record<string, Phase>): Promise<void> {
  for (const [slotId, phase] of Object.entries(phases)) await expectPhase(page, slotId, phase);
}

/**
 * Brings a cell on screen. A phone shows one cell at a time and renders an
 * answer only while its cell is shown, so there the cell's tab is chosen.
 */
export async function showCell(page: Page, viewport: Viewport, slotId: string): Promise<Locator> {
  if (viewport === 'phone') {
    await page.locator(`[id="wall-tab-${slotId}"]`).click();
    await expect(cell(page, slotId)).toBeVisible();
  } else {
    await cell(page, slotId).scrollIntoViewIfNeeded();
  }
  return cell(page, slotId);
}

/** Stores a preset on the server and applies it with one click, as a user would. */
export async function arrange(
  page: Page,
  server: TestServer,
  slots: AskTarget[],
  name = 'Test wall',
): Promise<void> {
  const id = `p-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  await server.putPreset(id, { name, slots });
  await page.reload();
  await presetBar(page).getByRole('button', { name, exact: true }).click();
  await expect(cells(page)).toHaveCount(slots.length);
  await expect(cell(page, slots[0]?.slotId ?? '')).toBeAttached();
}

export async function send(page: Page, text: string): Promise<void> {
  await prompt(page).fill(text);
  await sendButton(page).click();
}

/** The id of the ask this wall is following, from the arrangement the page keeps for reloads. */
export async function currentAskId(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => {
    const raw = window.sessionStorage.getItem('answerwall.wall.v1');
    const askId = raw === null ? null : (JSON.parse(raw) as { askId: string | null }).askId;
    return askId ?? false;
  });
  return (await handle.jsonValue()) as string;
}

/** The slot ids in the order the cells have in the document. */
export function slotOrder(page: Page): Promise<string[]> {
  return cells(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-slot-id') ?? ''),
  );
}

/** How many columns the grid currently lays its cells out in. */
export function columnCount(page: Page): Promise<number> {
  return page
    .getByTestId('wall-grid')
    .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
}
