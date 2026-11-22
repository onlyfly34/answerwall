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
  options: {
    desktop?: boolean;
    update?: FakeServices['settings']['update'];
    /** A slow server: every save waits here until the test calls the function pushed for it. */
    held?: (() => void)[];
  } = {},
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
  const { held } = options;
  const update =
    options.update ??
    (held &&
      (async (patch) => {
        await new Promise<void>((release) => held.push(release));
        await fake.settings.update(patch);
      }));
  const services = update ? { ...fake, settings: { ...fake.settings, update } } : fake;
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
    await waitFor(() =>
      expect(section().getByLabelText<HTMLInputElement>('Extension ID').value).toBe(''),
    );

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

  describe('two changes in quick succession, over a slow connection', () => {
    const release = async (held: (() => void)[], count: number): Promise<void> => {
      await waitFor(() => expect(held).toHaveLength(count));
      held[count - 1]?.();
    };
    const webProviders = (services: FakeServices) =>
      services.settings
        .settings()
        ?.providers.filter((provider) => provider.kind === 'web')
        .map((provider) => [provider.id, provider.enabled]);

    test('two sites ticked one after the other are both stored', async () => {
      const held: (() => void)[] = [];
      const services = setup(() => undefined, { held });

      fireEvent.click(box(/claude\.ai/));
      fireEvent.click(box(/chatgpt\.com/));
      // One save at a time: the second waits for the answer to the first.
      await release(held, 1);
      await release(held, 2);

      await waitFor(() =>
        expect(webProviders(services)).toEqual([
          ['web-claude', true],
          ['web-chatgpt', true],
        ]),
      );
      expect(services.settingsUpdates).toHaveLength(2);
      expect(box(/claude\.ai/).checked).toBe(true);
      expect(box(/chatgpt\.com/).checked).toBe(true);
    });

    test('removing one extension id and adding another keeps neither change from the other', async () => {
      const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba';
      const NEW = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
      const held: (() => void)[] = [];
      const services = setup((settings) => void (settings.webCells.extensionIds = [ID, OTHER]), {
        held,
      });

      fireEvent.click(section().getByRole('button', { name: `Remove ${ID}` }));
      setValue(section().getByLabelText('Extension ID'), NEW);
      fireEvent.click(section().getByRole('button', { name: 'Add' }));
      await release(held, 1);
      await release(held, 2);

      // The removed id is not allowed again by the save that came after it.
      await waitFor(() =>
        expect(services.settings.settings()?.webCells.extensionIds).toEqual([OTHER, NEW]),
      );
    });

    test('a refused save does not stop the ones after it', async () => {
      const refused = new ApiError('bad_request', 400, 'providers: nope');
      let calls = 0;
      const fake: { services?: FakeServices } = {};
      fake.services = setup(() => undefined, {
        update: async (patch) => {
          calls += 1;
          if (calls === 1) throw refused;
          await fake.services?.settings.update(patch);
        },
      });

      fireEvent.click(box(/claude\.ai/));
      fireEvent.click(box(/chatgpt\.com/));

      await waitFor(() => expect(webProviders(fake.services!)).toEqual([['web-chatgpt', true]]));
      expect(fake.services.errors).toEqual([refused]);
    });
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
