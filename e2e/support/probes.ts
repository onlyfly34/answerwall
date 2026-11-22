/**
 * Measurements taken inside the page: the timeline of every cell's phase, and
 * how responsive the main thread stays.
 */
import type { Page } from '@playwright/test';
import type { Phase } from './wall.ts';

export interface TimelineEntry {
  slotId: string;
  phase: Phase;
  /** The cell's status line at that moment. */
  status: string;
  /** Milliseconds since the page's time origin. */
  at: number;
}

declare global {
  interface Window {
    __wallTimeline?: TimelineEntry[];
    __responsiveness?: {
      longTasks: number[];
      maxFrameGap: number;
      frames: number;
      startedAt: number;
      stop(): void;
    };
  }
}

/**
 * Records every change of a cell's phase or status line from now on, across
 * reloads. Assertions on states that last only a moment (a cell that is
 * queued for a second) read this record instead of racing the page.
 */
export async function recordTimeline(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const timeline: TimelineEntry[] = [];
    const last = new Map<string, string>();
    window.__wallTimeline = timeline;
    const scan = (): void => {
      for (const element of document.querySelectorAll('article.wall-cell')) {
        const slotId = element.getAttribute('data-slot-id') ?? '';
        const phase = (element.getAttribute('data-phase') ?? 'idle') as TimelineEntry['phase'];
        const status = element.querySelector('.wall-cell-status')?.textContent?.trim() ?? '';
        const key = `${phase}\n${status}`;
        if (last.get(slotId) === key) continue;
        last.set(slotId, key);
        timeline.push({ slotId, phase, status, at: performance.now() });
      }
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
}

export function readTimeline(page: Page): Promise<TimelineEntry[]> {
  return page.evaluate(() => window.__wallTimeline ?? []);
}

/** The phases one slot went through, without repeats. */
export function phasesOf(timeline: TimelineEntry[], slotId: string): Phase[] {
  const phases: Phase[] = [];
  for (const entry of timeline) {
    if (entry.slotId === slotId && phases.at(-1) !== entry.phase) phases.push(entry.phase);
  }
  return phases;
}

/** The largest number of the given slots that were running at the same moment. */
export function peakRunning(timeline: TimelineEntry[], slotIds: readonly string[]): number {
  const running = new Set<string>();
  let peak = 0;
  for (const entry of timeline) {
    if (!slotIds.includes(entry.slotId)) continue;
    if (entry.phase === 'waiting' || entry.phase === 'streaming') running.add(entry.slotId);
    else running.delete(entry.slotId);
    peak = Math.max(peak, running.size);
  }
  return peak;
}

export interface Responsiveness {
  /** Durations of the main-thread tasks of 50 ms and more, as the browser reports them. */
  longTasks: number[];
  /** The longest time between two animation frames. */
  maxFrameGap: number;
  frames: number;
  durationMs: number;
}

/** Starts watching long tasks and animation frames. */
export async function startResponsivenessProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask' });
    const probe = {
      longTasks,
      maxFrameGap: 0,
      frames: 0,
      startedAt: performance.now(),
      stop: () => {
        running = false;
        for (const entry of observer.takeRecords()) longTasks.push(entry.duration);
        observer.disconnect();
      },
    };
    let running = true;
    let previous = performance.now();
    const frame = (now: number): void => {
      if (!running) return;
      probe.maxFrameGap = Math.max(probe.maxFrameGap, now - previous);
      probe.frames += 1;
      previous = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.__responsiveness = probe;
  });
}

export function stopResponsivenessProbe(page: Page): Promise<Responsiveness> {
  return page.evaluate(() => {
    const probe = window.__responsiveness;
    if (!probe) throw new Error('The responsiveness probe was not started');
    probe.stop();
    return {
      longTasks: probe.longTasks,
      maxFrameGap: probe.maxFrameGap,
      frames: probe.frames,
      durationMs: performance.now() - probe.startedAt,
    };
  });
}
