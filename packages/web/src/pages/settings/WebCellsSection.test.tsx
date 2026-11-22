import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, test } from 'vitest';
import {
  API_VERSION,
  createDefaultSettings,
  SettingsPatchSchema,
  WEB_SITES,
} from '@answerwall/core/protocol';
import type { Settings } from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import { createFakeServices } from '../../contracts/testing.ts';
import type { FakeServices } from '../../contracts/testing.ts';
import { renderPage, setValue } from '../test-support.tsx';
import { SettingsPage } from './SettingsPage.tsx';

afterEach(cleanup);

const ID = 'abcdefghijklmnopabcdefghijklmnop';

function setup(
  change: (settings: Settings) => void = () => undefined,
  options: { desktop?: boolean; update?: FakeServices['settings']['update'] } = {},
) {
  const settings = createDefaultSettings();
  change(settings);
  const fake = createFakeServices({
    settings,
    api: { listDevices: async () => ({ devices: [], maxDevices: 8 }) },
    ...(options.desktop
      ? {
          meta: {
            name: 'AnswerWall',
            version: '0.0.0-test',
            apiVersion: API_VERSION,
            mode: 'desktop',
            tls: 'off',
            authRequired: true,
          },
        }
      : {}),
  });
  const services = options.update
    ? { ...fake, settings: { ...fake.settings, update: options.update } }
    : fake;
  renderPage(
    () => <SettingsPage onLogout={() => Promise.resolve()} onSignedOut={() => undefined} />,
    services,
  );
  return fake;
}

const section = () => within(screen.getByRole('region', { name: 'Web cells' }));
const box = (name: string | RegExp) => section().getByRole<HTMLInputElement>('checkbox', { name });
const lastPatch = (services: FakeServices) => {
  const patch = services.settingsUpdates.at(-1);
  expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  return patch;
};

describe('the web cells settings', () => {
  test('everything is off at first, and the terms are stated without a verdict', () => {
    setup();

    for (const name of ['Allow web cells', 'Fill in the prompt', 'Read the answer']) {
      expect(box(name).checked).toBe(false);
    }
    for (const site of WEB_SITES) expect(box(new RegExp(site.host)).checked).toBe(false);
    expect(section().getByText('No extension may connect.')).toBeDefined();
    expect(section().getByText(/restrict automated access/)).toBeDefined();
  });

  test('each switch is saved on its own', async () => {
    const services = setup();

    fireEvent.click(box('Allow web cells'));
    await waitFor(() => expect(lastPatch(services)).toEqual({ webCells: { enabled: true } }));
    fireEvent.click(box('Fill in the prompt'));
    await waitFor(() => expect(lastPatch(services)).toEqual({ webCells: { fillPrompt: true } }));
    fireEvent.click(box('Read the answer'));
    await waitFor(() => expect(lastPatch(services)).toEqual({ webCells: { readAnswer: true } }));

    expect(services.settings.settings()?.webCells).toMatchObject({
      enabled: true,
      fillPrompt: true,
      readAnswer: true,
    });
  });

  test('an extension id is added to the list and can be removed again', async () => {
    const services = setup();

    setValue(section().getByLabelText('Extension ID'), ` ${ID} `);
    fireEvent.click(section().getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(lastPatch(services)).toEqual({ webCells: { extensionIds: [ID] } }));
    expect(await section().findByText(ID)).toBeDefined();
    expect(section().getByLabelText<HTMLInputElement>('Extension ID').value).toBe('');

    fireEvent.click(section().getByRole('button', { name: `Remove ${ID}` }));
    await waitFor(() => expect(lastPatch(services)).toEqual({ webCells: { extensionIds: [] } }));
  });

  test.each(['*', 'chrome-extension://' + ID, 'abc', ID.toUpperCase()])(
    '%s is not an extension id and is not sent',
    async (value) => {
      const services = setup();

      setValue(section().getByLabelText('Extension ID'), value);
      fireEvent.click(section().getByRole('button', { name: 'Add' }));

      await waitFor(() =>
        expect(section().getByLabelText('Extension ID').getAttribute('aria-invalid')).toBe('true'),
      );
      expect(services.settingsUpdates).toEqual([]);
    },
  );

  test('an id that is already listed is not sent again', async () => {
    const services = setup((settings) => void (settings.webCells.extensionIds = [ID]));

    setValue(section().getByLabelText('Extension ID'), ID);
    fireEvent.click(section().getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(section().getByLabelText<HTMLInputElement>('Extension ID').value).toBe(''),
    );
    expect(services.settingsUpdates).toEqual([]);
  });

  test('ticking a site adds its web provider; unticking disables it and keeps it', async () => {
    const services = setup();
    const before = createDefaultSettings().providers.length;

    fireEvent.click(box(/chatgpt\.com/));
    await waitFor(() => expect(lastPatch(services)?.providers).toHaveLength(before + 1));
    expect(lastPatch(services)?.providers?.at(-1)).toEqual({
      id: 'web-chatgpt',
      kind: 'web',
      site: 'chatgpt',
      label: 'ChatGPT (web)',
      enabled: true,
      concurrency: 2,
      models: [],
    });
    await waitFor(() => expect(box(/chatgpt\.com/).checked).toBe(true));

    fireEvent.click(box(/chatgpt\.com/));
    await waitFor(() =>
      expect(lastPatch(services)?.providers?.at(-1)).toMatchObject({
        id: 'web-chatgpt',
        enabled: false,
      }),
    );
    expect(lastPatch(services)?.providers).toHaveLength(before + 1);
  });

  test('a refused save puts the stored values back and reports the error', async () => {
    const refused = new ApiError('bad_request', 400, 'webCells.enabled: nope');
    const services = setup(() => undefined, { update: async () => Promise.reject(refused) });

    fireEvent.click(box('Allow web cells'));

    await waitFor(() => expect(services.errors).toEqual([refused]));
    await waitFor(() => expect(box('Allow web cells').checked).toBe(false));
  });

  test('the desktop app has no web cells section', () => {
    setup(() => undefined, { desktop: true });
    expect(screen.queryByRole('region', { name: 'Web cells' })).toBeNull();
  });

  test('the section reads the same in Traditional Chinese', async () => {
    const services = setup();
    services.i18n.setLanguage('zh-TW');
    expect(await screen.findByRole('region', { name: '網頁儲存格' })).toBeDefined();
    expect(screen.getByRole('checkbox', { name: '允許網頁儲存格' })).toBeDefined();
  });
});
