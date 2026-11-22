import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRenderScheduler, RENDER_INTERVAL_MAX_MS, RENDER_INTERVAL_MS } from './scheduler.ts';

describe('the render scheduler', () => {
  let time = 0;
  let renders = 0;
  let cost = 0;

  const create = () =>
    createRenderScheduler({
      now: () => time,
      render: () => {
        renders += 1;
        time += cost;
      },
    });
  const advance = (ms: number): void => {
    time += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    time = 1000;
    renders = 0;
    cost = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('the first request renders at once', () => {
    create().request();
    expect(renders).toBe(1);
  });

  test('requests within the interval collapse into one later render', () => {
    const scheduler = create();
    scheduler.request();
    for (let delta = 0; delta < 20; delta += 1) scheduler.request();
    expect(renders).toBe(1);
    advance(RENDER_INTERVAL_MS - 1);
    expect(renders).toBe(1);
    advance(1);
    expect(renders).toBe(2);
    advance(1000);
    expect(renders).toBe(2);
  });

  test('the interval stays within the 50–100 ms the design asks for', () => {
    expect(RENDER_INTERVAL_MS).toBeGreaterThanOrEqual(50);
    expect(RENDER_INTERVAL_MS).toBeLessThanOrEqual(100);
  });

  test('a steady stream renders about once per interval', () => {
    const scheduler = create();
    for (let ms = 0; ms < 1000; ms += 10) {
      scheduler.request();
      advance(10);
    }
    expect(renders).toBeGreaterThanOrEqual(11);
    expect(renders).toBeLessThanOrEqual(13);
  });

  test('a request after a quiet period renders at once again', () => {
    const scheduler = create();
    scheduler.request();
    advance(RENDER_INTERVAL_MS + 5);
    scheduler.request();
    expect(renders).toBe(2);
  });

  test('flush renders a pending request now and nothing when none is pending', () => {
    const scheduler = create();
    scheduler.flush();
    expect(renders).toBe(0);
    scheduler.request();
    scheduler.request();
    scheduler.flush();
    expect(renders).toBe(2);
    advance(1000);
    expect(renders).toBe(2);
  });

  test('a slow render stretches the interval so rendering takes a bounded share of the time', () => {
    cost = 100;
    const scheduler = create();
    scheduler.request();
    scheduler.request();
    advance(399);
    expect(renders).toBe(1);
    advance(1);
    expect(renders).toBe(2);
  });

  test('the interval never exceeds its maximum', () => {
    cost = 5000;
    const scheduler = create();
    scheduler.request();
    scheduler.request();
    advance(RENDER_INTERVAL_MAX_MS);
    expect(renders).toBe(2);
  });

  test('a paused scheduler remembers the request and renders when resumed', () => {
    const scheduler = create();
    scheduler.setPaused(true);
    scheduler.request();
    scheduler.flush();
    advance(1000);
    expect(renders).toBe(0);
    scheduler.setPaused(false);
    expect(renders).toBe(1);
  });

  test('pausing cancels a scheduled render until resumed', () => {
    const scheduler = create();
    scheduler.request();
    scheduler.request();
    scheduler.setPaused(true);
    advance(1000);
    expect(renders).toBe(1);
    scheduler.setPaused(false);
    expect(renders).toBe(2);
  });

  test('nothing renders after dispose', () => {
    const scheduler = create();
    scheduler.request();
    scheduler.request();
    scheduler.dispose();
    advance(1000);
    scheduler.flush();
    expect(renders).toBe(1);
  });
});
