// First, as in main.tsx: the setting is read when a schema is built.
import './zod-config.ts';
import { expect, test, vi } from 'vitest';
import { createDefaultSettings, SettingsSchema } from '@answerwall/core/protocol';

test('validation never compiles code, which the Content-Security-Policy would report', () => {
  const compile = vi.spyOn(globalThis, 'Function');
  expect(SettingsSchema.parse(createDefaultSettings()).language).toBe('en');
  expect(compile).not.toHaveBeenCalled();
});
