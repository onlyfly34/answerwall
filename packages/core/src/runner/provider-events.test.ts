import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { checkProviderEvent, utf8Prefix } from './provider-events.ts';

test('well-formed provider events pass unchanged', () => {
  const events = [
    { type: 'start' },
    { type: 'start', streaming: 'block' },
    { type: 'delta', text: 'a' },
    { type: 'reasoning', text: 'b' },
    { type: 'notice', message: 'c' },
    { type: 'done', usage: { inputTokens: 1, outputTokens: 2 }, elapsedMs: 3 },
    { type: 'error', code: 'quota', message: 'd' },
  ];
  for (const event of events) expect(checkProviderEvent(event)).toEqual(event);
});

test.each([
  null,
  undefined,
  42,
  'delta',
  [],
  {},
  { type: 'tool_call' },
  { type: 'delta' },
  { type: 'delta', text: 7 },
  { type: 'reasoning', text: null },
  { type: 'notice' },
])('%j is not a provider event', (value) => {
  expect(checkProviderEvent(value)).toBeNull();
});

test('an unusable optional field is dropped, the event kept', () => {
  expect(checkProviderEvent({ type: 'start', streaming: 'fast' })).toEqual({ type: 'start' });
  expect(checkProviderEvent({ type: 'done', elapsedMs: -1, usage: { inputTokens: 'x' } })).toEqual({
    type: 'done',
  });
  expect(checkProviderEvent({ type: 'done', elapsedMs: Number.NaN })).toEqual({ type: 'done' });
  expect(checkProviderEvent({ type: 'error', code: 'exploded', message: 5 })).toEqual({
    type: 'error',
    code: 'unknown',
    message: 'The provider reported an error',
  });
});

test('a UTF-8 prefix never exceeds the budget and never splits a character', () => {
  expect(utf8Prefix('hello', 100)).toBe('hello');
  expect(utf8Prefix('hello', 3)).toBe('hel');
  expect(utf8Prefix('hello', 0)).toBe('');
  // 'é' takes two bytes, '漢' three, the emoji four (a surrogate pair).
  expect(utf8Prefix('éé', 3)).toBe('é');
  expect(utf8Prefix('漢字', 5)).toBe('漢');
  expect(utf8Prefix('a😀b', 4)).toBe('a');
  expect(utf8Prefix('a😀b', 5)).toBe('a😀');
  const text = 'aé漢😀'.repeat(50);
  for (let budget = 0; budget <= Buffer.byteLength(text); budget++) {
    const prefix = utf8Prefix(text, budget);
    expect(Buffer.byteLength(prefix)).toBeLessThanOrEqual(budget);
    expect(text.startsWith(prefix)).toBe(true);
    expect(Buffer.from(prefix).toString()).toBe(prefix);
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(budget - 4);
  }
});
