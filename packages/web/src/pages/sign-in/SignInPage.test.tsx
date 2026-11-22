import { cleanup, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PairRequest, SessionRequest, SessionResponse } from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import { createFakeServices } from '../../contracts/testing.ts';
import { renderPage, setValue } from '../test-support.tsx';
import { suggestDeviceName } from './device-name.ts';
import { SignInPage } from './SignInPage.tsx';

afterEach(cleanup);

const session: SessionResponse = { device: null };

function setup(
  api: {
    pair?: (request: PairRequest) => Promise<SessionResponse>;
    signIn?: (request: SessionRequest) => Promise<SessionResponse>;
  } = {},
) {
  const pair = vi.fn(api.pair ?? (async () => session));
  const signIn = vi.fn(api.signIn ?? (async () => session));
  const onSignedIn = vi.fn();
  const services = createFakeServices({ api: { pair, signIn } });
  renderPage(() => <SignInPage onSignedIn={onSignedIn} />, services);
  return { pair, signIn, onSignedIn, services };
}

/** The text field with this label; the method radios carry the same words. */
const field = (name: string): HTMLInputElement =>
  screen.getByLabelText(name, { selector: 'input:not([type=radio])' });
const submit = (): void => void fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

describe('pairing with a code', () => {
  test('a code typed in groups is sent as digits with the device name, then the app loads', async () => {
    const { pair, signIn, onSignedIn } = setup();
    setValue(field('Pairing code'), '1234 5678');
    setValue(field('Device name'), '  Kitchen tablet ');

    submit();

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(pair).toHaveBeenCalledWith({ code: '12345678', deviceName: 'Kitchen tablet' });
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the device name starts with a suggestion from the browser', () => {
    setup();
    expect(field('Device name').value).toBe(suggestDeviceName(navigator.userAgent));
  });

  test.each(['1234', '1234567a', '123456789', ''])(
    'a code that is not eight digits (%j) is refused before anything is sent',
    async (code) => {
      const { pair, onSignedIn } = setup();
      setValue(field('Pairing code'), code);

      submit();

      expect(await screen.findByText('Enter the 8 digits of the pairing code.')).toBeDefined();
      expect(field('Pairing code').getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(field('Pairing code'));
      expect(pair).not.toHaveBeenCalled();
      expect(onSignedIn).not.toHaveBeenCalled();
    },
  );

  test('an empty device name is refused', async () => {
    const { pair } = setup();
    setValue(field('Pairing code'), '12345678');
    setValue(field('Device name'), '   ');

    submit();

    expect(await screen.findByText('Enter a name of 1 to 64 characters.')).toBeDefined();
    expect(document.activeElement).toBe(field('Device name'));
    expect(pair).not.toHaveBeenCalled();
  });

  test.each([
    [
      'a wrong or expired code',
      new ApiError('invalid_code', 401, 'Invalid pairing code'),
      'That code is wrong, was already used or has expired. Create a new code and try again.',
    ],
    [
      'too many attempts',
      new ApiError('rate_limited', 429, 'Too many attempts'),
      'Too many failed attempts from this address. Wait a minute, then try again.',
    ],
    [
      'a full device list',
      new ApiError('device_limit', 409, 'Too many devices'),
      'The maximum number of devices is already paired. Revoke one in Settings on a signed-in device first.',
    ],
    [
      'an unreachable server',
      new ApiError('network', 0, 'unreachable'),
      'The server cannot be reached.',
    ],
    ['a defect', new TypeError('boom'), 'Something went wrong.'],
  ])('%s is explained in place and the form can be sent again', async (_name, error, message) => {
    const { pair, onSignedIn, services } = setup({
      pair: vi
        .fn<(request: PairRequest) => Promise<SessionResponse>>()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(session),
    });
    setValue(field('Pairing code'), '12345678');

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(onSignedIn).not.toHaveBeenCalled();
    // Explained on the page itself, not as a toast or a redirect.
    expect(services.toasts).toEqual([]);
    expect(services.errors).toEqual([]);

    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(pair).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the button is disabled while the request is in flight, so it cannot be sent twice', async () => {
    let finish!: (value: SessionResponse) => void;
    const { pair } = setup({
      pair: () => new Promise<SessionResponse>((resolve) => (finish = resolve)),
    });
    setValue(field('Pairing code'), '12345678');

    submit();

    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Signing in…' });
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest('form') as HTMLFormElement);
    expect(pair).toHaveBeenCalledTimes(1);

    finish(session);
    await screen.findByRole('button', { name: 'Sign in' });
  });
});

describe('signing in with a token', () => {
  function chooseToken(): void {
    fireEvent.click(screen.getByRole('radio', { name: 'Access token' }));
  }

  test('the token is trimmed and sent, never the pairing fields', async () => {
    const { pair, signIn, onSignedIn } = setup();
    chooseToken();
    expect(screen.queryByLabelText('Device name')).toBeNull();
    const token = field('Access token');
    expect(token.type).toBe('password');
    setValue(token, '  0123456789abcdef0123456789abcdef  ');

    submit();

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ token: '0123456789abcdef0123456789abcdef' });
    expect(pair).not.toHaveBeenCalled();
  });

  test('a token that is too short is refused before anything is sent', async () => {
    const { signIn } = setup();
    chooseToken();
    setValue(field('Access token'), 'short');

    submit();

    expect(
      await screen.findByText('Enter the whole token (at least 16 characters).'),
    ).toBeDefined();
    expect(signIn).not.toHaveBeenCalled();
  });

  test('a rejected token says so', async () => {
    setup({
      signIn: async () => {
        throw new ApiError('unauthorized', 401, 'Invalid token');
      },
    });
    chooseToken();
    setValue(field('Access token'), '0123456789abcdef');

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe('That token is not accepted.');
  });
});

describe('language', () => {
  test('the page can be switched before signing in', () => {
    const { services } = setup();

    setValue(screen.getByLabelText('Language'), 'zh-TW');

    expect(services.i18n.language()).toBe('zh-TW');
    expect(screen.getByRole('button', { name: '登入' })).toBeDefined();
    expect(field('配對碼')).toBeDefined();
  });
});

describe('device name suggestion', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9)', 'Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows PC'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 'Chromebook'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux PC'],
    ['SomethingElse/1.0', 'Browser'],
  ])('%s is suggested as %s', (userAgent, name) => {
    expect(suggestDeviceName(userAgent)).toBe(name);
  });
});
