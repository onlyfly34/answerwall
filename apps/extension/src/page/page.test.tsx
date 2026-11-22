import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, test } from 'vitest';
import { API_VERSION } from '@answerwall/core/protocol';
import { EXTENSION_MESSAGES, pickLanguage, translator } from './messages.ts';
import type { ExtensionMessageKey } from './messages.ts';
import type { PairingEnvironment } from './pairing.ts';
import { Setup } from './Setup.tsx';

const ID = 'nffcmlcjkacklpololkpdmhcfokannom';

afterEach(cleanup);

describe('the messages', () => {
  test('English and Traditional Chinese have the same keys and the same placeholders', () => {
    const en = EXTENSION_MESSAGES.en;
    const zh = EXTENSION_MESSAGES['zh-TW'];
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as ExtensionMessageKey[]) {
      expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
      expect(zh[key].trim(), key).not.toBe('');
    }
  });

  test('neither language says that using a web app this way is allowed', () => {
    for (const messages of Object.values(EXTENSION_MESSAGES)) {
      expect(messages['setup.terms']).toMatch(/restrict|限制/);
      expect(JSON.stringify(messages)).not.toMatch(/compliant|is allowed|合規|符合條款/i);
    }
  });

  test('the language is the web UI’s stored choice, else the browser’s, else English', () => {
    expect(pickLanguage('zh-TW', ['en-US'])).toBe('zh-TW');
    expect(pickLanguage(null, ['fr-FR', 'zh-Hant-TW', 'en'])).toBe('zh-TW');
    expect(pickLanguage('klingon', ['en-GB'])).toBe('en');
    expect(pickLanguage(undefined, [])).toBe('en');
  });

  test('placeholders are filled in; an unknown one stays visible', () => {
    const t = translator(() => 'en');
    expect(t('strip.server', { origin: 'https://wall.example.com' })).toBe(
      'Server: https://wall.example.com',
    );
    expect(t('strip.server')).toBe('Server: {origin}');
  });
});

function setup(
  answers: { meta?: unknown; pair?: { status: number; body: unknown } } = {},
  granted = true,
) {
  const requests: { url: string; body: unknown }[] = [];
  const paired: [string, string][] = [];
  const copied: string[] = [];
  const environment: PairingEnvironment = {
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : '';
      requests.push({
        url,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status });
      if (url.endsWith('/api/meta')) {
        return json(
          answers.meta ?? {
            name: 'AnswerWall',
            version: '1.0.0',
            apiVersion: API_VERSION,
            mode: 'server',
            tls: 'off',
            authRequired: true,
          },
        );
      }
      const pair = answers.pair ?? {
        status: 200,
        body: {
          device: { id: 'd-1', name: 'x', createdAt: 1, lastUsedAt: null, current: true },
          token: 'device-token-0123456789abcdef',
        },
      };
      return json(pair.body, pair.status);
    },
    permissions: { contains: async () => false, request: async () => granted },
  };
  render(() => (
    <Setup
      t={translator(() => 'en')}
      extensionId={ID}
      environment={environment}
      copy={(text) => {
        copied.push(text);
        return Promise.resolve();
      }}
      onPaired={(origin, token) => void paired.push([origin, token])}
    />
  ));
  return { requests, paired, copied };
}

const fill = (label: string, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};

describe('the first-run page', () => {
  test('shows the ID the server must list, and copies it', async () => {
    const { copied } = setup();
    expect(screen.getByTestId('extension-id').textContent).toBe(ID);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
    expect(copied).toEqual([ID]);
  });

  test('says in plain words that the sites restrict automated access and that the user decides', () => {
    setup();
    expect(document.body.textContent).toContain('restrict automated access');
    expect(document.body.textContent).toContain('your decision');
  });

  test('pairs with the address and the code, and hands over the origin and the token', async () => {
    const { requests, paired } = setup();
    fill('Server address', 'wall.example.com/some/page');
    fill('Pairing code', '1234 5678');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(paired).toHaveLength(1));
    expect(paired[0]).toEqual(['https://wall.example.com', 'device-token-0123456789abcdef']);
    expect(requests.map((request) => request.url)).toEqual([
      'https://wall.example.com/api/meta',
      'https://wall.example.com/api/auth/pair',
    ]);
    expect(requests[1]?.body).toEqual({ code: '1234 5678', deviceName: 'Browser extension' });
  });

  test('an address that is no address, or a missing code, is refused before anything is requested', async () => {
    const { requests, paired } = setup();
    fill('Server address', 'ftp://wall.example.com');
    fill('Pairing code', '1234');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('http:// or https://');

    fill('Server address', 'https://wall.example.com');
    fill('Pairing code', '  ');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Enter the pairing code'),
    );
    expect(requests).toEqual([]);
    expect(paired).toEqual([]);
  });

  test('a server that does not list the extension: the page says what to do', async () => {
    const { paired } = setup({ pair: { status: 403, body: { error: { code: 'forbidden' } } } });
    fill('Server address', 'https://wall.example.com');
    fill('Pairing code', '1234 5678');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Switch web cells on under Settings > Web cells',
    );
    expect(paired).toEqual([]);
    // The form is usable again.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(false);
  });

  test('a declined permission prompt', async () => {
    const { requests } = setup({}, false);
    fill('Server address', 'https://wall.example.com');
    fill('Pairing code', '1234 5678');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'did not give the extension access',
    );
    expect(requests).toEqual([]);
  });
});
