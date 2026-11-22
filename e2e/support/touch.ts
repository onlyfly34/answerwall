/** Real touch input, which Playwright's own API offers only as a tap. */
import type { Page } from '@playwright/test';

const REST_BEFORE_LIFT_MS = 120;

export interface Point {
  x: number;
  y: number;
}

/**
 * A finger put down at `from`, dragged to `to` and lifted. The browser turns
 * the touch points into pointer events itself and applies `touch-action`, so
 * a gesture the page would lose to scrolling is lost here too.
 *
 * The finger rests for a moment before it lifts. Lifted at speed, the browser
 * starts a fling, and it swallows the next tap to stop that fling, which
 * would make a tap right after a swipe depend on timing.
 */
export async function swipe(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (position: Point) => [{ x: position.x, y: position.y, id: 1 }];
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: point(from),
    });
    for (let step = 1; step <= steps; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point({
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        }),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, REST_BEFORE_LIFT_MS));
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}
