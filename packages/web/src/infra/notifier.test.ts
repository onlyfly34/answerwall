import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { API_ERROR_CODES } from '@answerwall/core/protocol';
import { createI18n } from '../contracts/i18n.ts';
import { ApiError } from '../contracts/services.ts';
import { errorMessage } from './error-messages.ts';
import { createNotifier, MAX_TOASTS, TOAST_DURATION_MS } from './notifier.ts';

const i18n = createI18n('en');

function harness() {
  const onUnauthorized = vi.fn();
  return { onUnauthorized, notifier: createNotifier({ t: i18n.t, onUnauthorized }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toasts', () => {
  test('a toast is shown, then expires by itself; errors stay longer', () => {
    const { notifier } = harness();
    notifier.toast({ kind: 'success', message: 'Saved.' });
    notifier.toast({ kind: 'error', message: 'Failed.' });
    expect(notifier.toasts().map((item) => item.message)).toEqual(['Saved.', 'Failed.']);

    vi.advanceTimersByTime(TOAST_DURATION_MS.success);
    expect(notifier.toasts().map((item) => item.message)).toEqual(['Failed.']);

    vi.advanceTimersByTime(TOAST_DURATION_MS.error - TOAST_DURATION_MS.success);
    expect(notifier.toasts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('dismiss removes one toast and its timer', () => {
    const { notifier } = harness();
    notifier.toast({ kind: 'info', message: 'one' });
    notifier.toast({ kind: 'info', message: 'two' });
    const first = notifier.toasts()[0];

    notifier.dismiss(first?.id ?? -1);

    expect(notifier.toasts().map((item) => item.message)).toEqual(['two']);
    expect(vi.getTimerCount()).toBe(1);
  });

  test('the same message again restarts its timer instead of stacking', () => {
    const { notifier } = harness();
    notifier.toast({ kind: 'error', message: 'Failed.' });
    vi.advanceTimersByTime(TOAST_DURATION_MS.error - 1);
    notifier.toast({ kind: 'error', message: 'Failed.' });

    expect(notifier.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS.error - 1);
    expect(notifier.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(notifier.toasts()).toEqual([]);
  });

  test('the stack is bounded: the oldest make room', () => {
    const { notifier } = harness();
    for (let index = 0; index < MAX_TOASTS + 3; index += 1) {
      notifier.toast({ kind: 'info', message: `message ${index}` });
    }

    expect(notifier.toasts().map((item) => item.message)).toEqual(
      Array.from({ length: MAX_TOASTS }, (_, index) => `message ${index + 3}`),
    );
    expect(vi.getTimerCount()).toBe(MAX_TOASTS);
  });
});

describe('reportError', () => {
  test('an API error becomes a translated error toast', () => {
    const { notifier, onUnauthorized } = harness();

    notifier.reportError(new ApiError('queue_full', 429, 'server wording'));

    expect(notifier.toasts()).toMatchObject([
      { kind: 'error', message: 'The queue is full. Wait for some answers to finish.' },
    ]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('any 401 returns to sign-in instead of showing a toast', () => {
    const { notifier, onUnauthorized } = harness();

    notifier.reportError(new ApiError('unauthorized', 401, 'no session'));
    notifier.reportError(new ApiError('invalid_response', 401, 'HTTP 401'));

    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(notifier.toasts()).toEqual([]);
  });

  test('anything else is logged for diagnosis and shown as a general failure', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { notifier } = harness();
    const defect = new TypeError('x is undefined');

    notifier.reportError(defect);
    notifier.reportError('a string');

    expect(logged).toHaveBeenCalledWith(defect);
    expect(notifier.toasts()).toMatchObject([{ kind: 'error', message: 'Something went wrong.' }]);
  });
});

describe('error messages', () => {
  test('every error code has its own message in both languages', () => {
    const codes = [...API_ERROR_CODES, 'network', 'invalid_response'] as const;
    for (const language of ['en', 'zh-TW'] as const) {
      const translator = createI18n(language);
      const messages = codes.map((code) =>
        errorMessage(new ApiError(code, 400, 'detail'), translator.t),
      );
      expect(new Set(messages).size, language).toBe(codes.length);
      for (const message of messages) expect(message).not.toMatch(/\{\w+\}/);
    }
  });

  test("the server's wording is included where it names what was refused", () => {
    expect(
      errorMessage(new ApiError('bad_request', 400, 'limits.maxAsksInFlight: too big'), i18n.t),
    ).toBe('The server refused the request: limits.maxAsksInFlight: too big');
    expect(errorMessage(new ApiError('internal', 500, 'stack trace'), i18n.t)).toBe(
      'The server ran into an error.',
    );
  });
});
