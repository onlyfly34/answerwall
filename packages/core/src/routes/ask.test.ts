import { expect, test } from 'vitest';
import { API_PATHS, AskSnapshotSchema, SSE_PING_INTERVAL_MS } from '../protocol/index.ts';
import type { AskRequest } from '../protocol/index.ts';
import { createTestApp, flushPromises, TEST_TOKEN } from '../testing/index.ts';
import type { TestApp } from '../testing/index.ts';

const request: AskRequest = {
  prompt: 'What is 2 + 2?',
  targets: [{ slotId: 'a', providerId: 'claude', model: 'sonnet' }],
};
const slot = { slotId: 'a', providerId: 'claude' };

async function submit(t: TestApp): Promise<string> {
  const response = await t.request('POST', API_PATHS.ask, request);
  expect(response.status).toBe(200);
  return ((await response.json()) as { askId: string }).askId;
}

function answer(t: TestApp, askId: string): void {
  t.asks.emit(askId, { type: 'start', ...slot, at: t.clock.now(), streaming: 'token' });
  t.asks.emit(askId, { type: 'delta', ...slot, text: '4' });
  t.asks.emit(askId, { type: 'done', ...slot, elapsedMs: 12 });
  t.asks.emit(askId, { type: 'ask_done' });
}

test('an ask can be submitted, read as a snapshot and cancelled', async () => {
  const t = createTestApp();
  const askId = await submit(t);

  const cancelled = await t.request('POST', API_PATHS.askCancel(askId), {});
  expect(await cancelled.json()).toEqual({ cancelled: ['a'] });

  const snapshot = AskSnapshotSchema.parse(
    await (await t.request('GET', API_PATHS.askSnapshot(askId))).json(),
  );
  expect(snapshot.slots.map((s) => s.status)).toEqual(['cancelled']);
});

test('the stream replays the event log as server-sent events and ends after ask_done', async () => {
  const t = createTestApp();
  const askId = await submit(t);
  answer(t, askId);

  const response = await t.request('GET', API_PATHS.askStream(askId));

  expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Accel-Buffering')).toBe('no');
  const messages = (await response.text()).trimEnd().split('\n\n');
  expect(messages.map((message) => message.split('\n').slice(0, 2))).toEqual([
    ['id: 1', 'event: start'],
    ['id: 2', 'event: delta'],
    ['id: 3', 'event: done'],
    ['id: 4', 'event: ask_done'],
  ]);
  expect(messages[1]).toContain(
    `data: ${JSON.stringify({ type: 'delta', ...slot, text: '4', seq: 2 })}`,
  );
});

test('the stream resumes after ?after= and Last-Event-ID, the header winning', async () => {
  const t = createTestApp();
  const askId = await submit(t);
  answer(t, askId);
  const ids = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map((match) => match[1]);

  const byQuery = await t.request('GET', API_PATHS.askStream(askId, 2));
  expect(ids(await byQuery.text())).toEqual(['3', '4']);

  const byHeader = await t.app.request(API_PATHS.askStream(askId, 1), {
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Last-Event-ID': '3' },
  });
  expect(ids(await byHeader.text())).toEqual(['4']);
});

test('an idle stream is kept alive with ping comments', async () => {
  const t = createTestApp();
  const askId = await submit(t);
  const response = await t.request('GET', API_PATHS.askStream(askId));
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

  await flushPromises();
  await t.clock.advance(SSE_PING_INTERVAL_MS);
  expect((await reader.read()).value).toBe(': ping\n\n');

  t.asks.emit(askId, { type: 'ask_done' });
  expect((await reader.read()).value).toContain('event: ask_done');
  expect((await reader.read()).done).toBe(true);
  expect(t.clock.pendingTimers).toBe(0);
});

test('an unknown ask is a 404 before any stream is opened', async () => {
  const t = createTestApp();
  const response = await t.request('GET', API_PATHS.askStream('missing'));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'No such ask' } });
});
