import { expect, test } from 'vitest';
import type { ProviderEvent } from '../contracts/index.ts';
import { createDefaultSettings } from '../protocol/index.ts';
import { answerScript, FakeClock, FakeProviderAdapter, flushPromises } from './index.ts';

const instance = createDefaultSettings().providers[0]!;
const request = { prompt: 'hi', timeoutMs: 300_000, workDir: 'w' };

async function collect(events: AsyncIterable<ProviderEvent>, into: ProviderEvent[]): Promise<void> {
  for await (const event of events) into.push(event);
}

test('FakeClock runs timers in order, including ones scheduled while advancing', async () => {
  const clock = new FakeClock(0);
  const fired: string[] = [];
  clock.schedule(20, () => fired.push('b'));
  clock.schedule(10, () => {
    fired.push('a');
    clock.schedule(5, () => fired.push('a+5'));
  });
  const cancel = clock.schedule(15, () => fired.push('cancelled'));
  cancel();

  await clock.advance(20);

  expect(fired).toEqual(['a', 'a+5', 'b']);
  expect(clock.now()).toBe(20);
});

test('FakeProviderAdapter replays its script on the clock', async () => {
  const clock = new FakeClock();
  const adapter = new FakeProviderAdapter({
    kind: 'claude',
    clock,
    script: answerScript(['Hel', 'lo'], 100),
  });
  const events: ProviderEvent[] = [];
  const finished = collect(
    adapter.run(instance, { ...request, signal: new AbortController().signal }),
    events,
  );

  await clock.advance(100);
  expect(events.map((event) => event.type)).toEqual(['start', 'delta']);

  await clock.advance(200);
  await finished;
  expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done']);
  expect(adapter.runs[0]?.request.prompt).toBe('hi');
});

test('FakeProviderAdapter stops a hanging run when the request is aborted', async () => {
  const clock = new FakeClock();
  const adapter = new FakeProviderAdapter({
    kind: 'codex',
    clock,
    script: [
      { event: { type: 'start' } },
      { hang: true },
      { event: { type: 'done', elapsedMs: 0 } },
    ],
  });
  const abort = new AbortController();
  const events: ProviderEvent[] = [];
  const finished = collect(adapter.run(instance, { ...request, signal: abort.signal }), events);
  await flushPromises();
  expect(adapter.active).toBe(1);

  abort.abort();
  await finished;

  expect(events).toEqual([{ type: 'start' }]);
  expect(adapter.active).toBe(0);
});
