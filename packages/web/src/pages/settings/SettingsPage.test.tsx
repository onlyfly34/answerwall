import { cleanup, fireEvent, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { API_VERSION, DEFAULT_LIMITS, SettingsPatchSchema } from '@answerwall/core/protocol';
import type {
  Device,
  DevicesResponse,
  Meta,
  PairingCodeResponse,
  ServerInfo,
} from '@answerwall/core/protocol';
import { ApiError } from '../../contracts/services.ts';
import type { ApiClient } from '../../contracts/services.ts';
import { createFakeServices } from '../../contracts/testing.ts';
import type { FakeServices } from '../../contracts/testing.ts';
import { renderPage, setValue } from '../test-support.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { CA_FILE_NAME } from './TlsSection.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const device = (id: string, overrides: Partial<Device> = {}): Device => ({
  id,
  name: `Device ${id}`,
  createdAt: Date.UTC(2026, 0, 1),
  lastUsedAt: null,
  current: false,
  ...overrides,
});

const twoDevices = (): DevicesResponse => ({
  devices: [
    device('a', { name: 'Laptop', current: true, lastUsedAt: Date.UTC(2026, 0, 2) }),
    device('b', { name: 'Phone' }),
  ],
  maxDevices: 8,
});

function serverInfo(tls: Partial<ServerInfo['tls']>, publicOrigins: string[] = []): ServerInfo {
  return {
    mode: 'server',
    tls: { mode: 'off', insecure: false, caCertificatePem: null, ...tls },
    publicOrigins,
  };
}

interface SetupOptions {
  meta?: Meta;
  server?: ServerInfo;
  api?: Partial<ApiClient>;
  /** Replaces `settings.update`, to make the server refuse. */
  update?: FakeServices['settings']['update'];
}

function setup(options: SetupOptions = {}) {
  const onLogout = vi.fn(async () => undefined);
  const onSignedOut = vi.fn();
  const fake = createFakeServices({
    ...(options.server ? { server: options.server } : {}),
    ...(options.meta ? { meta: options.meta } : {}),
    api: { listDevices: async () => twoDevices(), ...options.api },
  });
  const services = options.update
    ? { ...fake, settings: { ...fake.settings, update: options.update } }
    : fake;
  renderPage(() => <SettingsPage onLogout={onLogout} onSignedOut={onSignedOut} />, services);
  return { services: fake, onLogout, onSignedOut };
}

const section = (name: string) => within(screen.getByRole('region', { name }));
const lastPatch = (services: FakeServices) => {
  const patch = services.settingsUpdates.at(-1);
  expect(SettingsPatchSchema.safeParse(patch).success).toBe(true);
  return patch;
};

describe('language, layout and updates', () => {
  test('choosing a language applies it at once and saves it', async () => {
    const { services } = setup();

    setValue(section('Language').getByLabelText('Language'), 'zh-TW');

    expect(services.i18n.language()).toBe('zh-TW');
    expect(screen.getByRole('heading', { level: 1, name: '設定' })).toBeDefined();
    await waitFor(() => expect(lastPatch(services)).toEqual({ language: 'zh-TW' }));
  });

  test('the layout defaults are saved field by field', async () => {
    const { services } = setup();
    const layout = section('Wall layout');
    expect(layout.getByRole<HTMLInputElement>('radio', { name: /As many as fit/ }).checked).toBe(
      true,
    );

    fireEvent.click(layout.getByRole('radio', { name: 'A fixed number' }));
    await waitFor(() => expect(lastPatch(services)).toEqual({ layout: { mode: 'fixed' } }));

    setValue(layout.getByLabelText('Number of columns'), '4');
    await waitFor(() => expect(lastPatch(services)).toEqual({ layout: { columns: 4 } }));

    setValue(layout.getByLabelText('Minimum cell width (pixels)'), '480');
    await waitFor(() => expect(lastPatch(services)).toEqual({ layout: { minCellWidth: 480 } }));
    expect(services.settings.settings()?.layout).toEqual({
      mode: 'fixed',
      columns: 4,
      minCellWidth: 480,
    });
  });

  test('a number typed while an earlier change is still being saved is kept', async () => {
    let land: () => void = () => undefined;
    const fake = setup();
    const layout = section('Wall layout');
    const columns = layout.getByLabelText<HTMLInputElement>('Number of columns');
    // A slow connection: the first save comes back only after the user typed on.
    const update = fake.services.settings.update.bind(fake.services.settings);
    fake.services.settings.update = async (patch) => {
      await new Promise<void>((resolve) => (land = resolve));
      await update(patch);
    };

    fireEvent.click(layout.getByRole('radio', { name: 'A fixed number' }));
    columns.value = '4';
    columns.dispatchEvent(new Event('input', { bubbles: true }));
    land();
    await waitFor(() => expect(fake.services.settings.settings()?.layout.mode).toBe('fixed'));

    expect(columns.value).toBe('4');
    columns.dispatchEvent(new Event('change', { bubbles: true }));
    land();
    await waitFor(() =>
      expect(fake.services.settings.settings()?.layout).toMatchObject({
        mode: 'fixed',
        columns: 4,
      }),
    );
  });

  test.each([
    ['Number of columns', '0'],
    ['Number of columns', '13'],
    ['Number of columns', '2.5'],
    ['Minimum cell width (pixels)', '239'],
    ['Minimum cell width (pixels)', '1201'],
  ])('%s = %s is outside the bounds: flagged, not saved', (label, value) => {
    const { services } = setup();
    const input = section('Wall layout').getByLabelText(label);

    setValue(input, value);

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(services.settingsUpdates).toEqual([]);
  });

  test('the release check can be switched off', async () => {
    const { services } = setup();
    const box = section('Updates').getByRole<HTMLInputElement>('checkbox', {
      name: 'Check for new releases',
    });
    expect(box.checked).toBe(true);
    expect(
      section('Updates').getByText('the only request this app makes to a third party', {
        exact: false,
      }),
    ).toBeDefined();

    fireEvent.click(box);

    await waitFor(() => expect(lastPatch(services)).toEqual({ updateCheck: false }));
  });

  test('a refused change is reported and the control shows the stored value again', async () => {
    const refusal = new ApiError('bad_request', 400, 'updateCheck: refused');
    const { services } = setup({ update: () => Promise.reject(refusal) });

    fireEvent.click(section('Updates').getByRole('checkbox', { name: 'Check for new releases' }));

    await waitFor(() => expect(services.errors).toEqual([refusal]));
    await waitFor(() =>
      expect(
        section('Updates').getByRole<HTMLInputElement>('checkbox', {
          name: 'Check for new releases',
        }).checked,
      ).toBe(true),
    );
  });
});

describe('limits', () => {
  const limits = () => section('Limits');
  const save = () => fireEvent.click(limits().getByRole('button', { name: 'Save' }));

  test('the stored limits are shown in readable units with their bounds', () => {
    setup();

    const targets = limits().getByLabelText<HTMLInputElement>('Cells per ask (count)');
    expect(targets.value).toBe('32');
    expect(targets.min).toBe('1');
    expect(targets.max).toBe('64');
    expect(limits().getByText('1 to 64; default 32.')).toBeDefined();
    expect(limits().getByLabelText<HTMLInputElement>('Prompt size (KiB)').value).toBe('200');
    expect(limits().getByLabelText<HTMLInputElement>('Time limit per answer (seconds)').value).toBe(
      '300',
    );
    expect(limits().getByLabelText<HTMLInputElement>('History size (MiB)').value).toBe('500');
  });

  test('valid limits are saved in bytes and milliseconds', async () => {
    const { services } = setup();
    setValue(limits().getByLabelText('Cells per ask (count)'), '12');
    setValue(limits().getByLabelText('Time limit per answer (seconds)'), '90');
    setValue(limits().getByLabelText('Prompt size (KiB)'), '64');

    save();

    await waitFor(() => expect(services.settingsUpdates).toHaveLength(1));
    expect(lastPatch(services)).toEqual({
      limits: {
        ...DEFAULT_LIMITS,
        maxTargetsPerAsk: 12,
        slotTimeoutMs: 90_000,
        maxPromptBytes: 64 * 1024,
      },
    });
    await waitFor(() =>
      expect(services.toasts).toContainEqual({ kind: 'success', message: 'Saved.' }),
    );
  });

  test('a value beyond its hard maximum is flagged with its range and nothing is saved', () => {
    const { services } = setup();
    const targets = limits().getByLabelText('Cells per ask (count)');
    setValue(targets, '65');
    setValue(limits().getByLabelText('Asks running at once (count)'), '0');

    save();

    expect(targets.getAttribute('aria-invalid')).toBe('true');
    expect(limits().getByText('Enter a number from 1 to 64.')).toBeDefined();
    expect(limits().getByText('Enter a number from 1 to 16.')).toBeDefined();
    expect(document.activeElement).toBe(targets);
    expect(services.settingsUpdates).toEqual([]);
  });

  test('a prompt limit that is not below the request limit is refused', () => {
    const { services } = setup();
    setValue(limits().getByLabelText('Prompt size (KiB)'), '2048');

    save();

    expect(
      limits().getByText('The prompt limit must be smaller than the request limit.'),
    ).toBeDefined();
    expect(services.settingsUpdates).toEqual([]);
  });

  test('the defaults can be filled in without saving', () => {
    const { services } = setup();
    const targets = limits().getByLabelText<HTMLInputElement>('Cells per ask (count)');
    setValue(targets, '999');
    save();
    expect(targets.getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(limits().getByRole('button', { name: 'Fill in the defaults' }));

    expect(targets.value).toBe('32');
    expect(targets.getAttribute('aria-invalid')).toBe('false');
    expect(services.settingsUpdates).toEqual([]);
  });

  test('a save the server refuses is reported and what was typed stays', async () => {
    const refusal = new ApiError('bad_request', 400, 'limits: refused');
    const { services } = setup({ update: () => Promise.reject(refusal) });
    const targets = limits().getByLabelText<HTMLInputElement>('Cells per ask (count)');
    setValue(targets, '12');

    save();

    await waitFor(() => expect(services.errors).toEqual([refusal]));
    expect(targets.value).toBe('12');
    expect(services.toasts).toEqual([]);
  });
});

describe('devices', () => {
  const devices = () => section('Devices');

  test('the paired devices are listed with the current one marked', async () => {
    setup();

    const items = await devices().findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Laptop');
    expect(items[0]?.textContent).toContain('This device');
    expect(items[0]?.textContent).toContain('last used');
    expect(items[1]?.textContent).toContain('Phone');
    expect(items[1]?.textContent).toContain('never used');
    expect(devices().getByText('2 of at most 8 devices are paired.')).toBeDefined();
  });

  test('revoking another device asks first, then removes it from the list', async () => {
    const revokeDevice = vi.fn(async () => undefined);
    const { services, onSignedOut } = setup({ api: { revokeDevice } });
    fireEvent.click(await devices().findByRole('button', { name: 'Revoke Phone' }));

    const confirm = within(screen.getByRole('dialog', { name: 'Revoke Phone?' }));
    expect(revokeDevice).not.toHaveBeenCalled();
    fireEvent.click(confirm.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(devices().queryByText('Phone')).toBeNull());
    expect(revokeDevice).toHaveBeenCalledWith('b');
    expect(services.toasts).toContainEqual({
      kind: 'success',
      message: 'The device was revoked.',
    });
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  test('cancelling the question revokes nothing', async () => {
    const revokeDevice = vi.fn(async () => undefined);
    setup({ api: { revokeDevice } });
    fireEvent.click(await devices().findByRole('button', { name: 'Revoke Phone' }));

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(revokeDevice).not.toHaveBeenCalled();
  });

  test('revoking the device in use warns about it and then returns to sign-in', async () => {
    const revokeDevice = vi.fn(async () => undefined);
    const { onSignedOut } = setup({ api: { revokeDevice } });
    fireEvent.click(await devices().findByRole('button', { name: 'Revoke Laptop' }));

    const confirm = within(screen.getByRole('dialog'));
    expect(confirm.getByText('This is the device you are using.', { exact: false })).toBeDefined();
    fireEvent.click(confirm.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(revokeDevice).toHaveBeenCalledWith('a');
  });

  test('a failed revoke is reported and the device stays listed', async () => {
    const failure = new ApiError('internal', 500, 'oops');
    const { services } = setup({ api: { revokeDevice: () => Promise.reject(failure) } });
    fireEvent.click(await devices().findByRole('button', { name: 'Revoke Phone' }));

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(services.errors).toEqual([failure]));
    expect(devices().getByText('Phone')).toBeDefined();
  });

  test('a pairing code is created on request and shown with its expiry', async () => {
    const code: PairingCodeResponse = { code: '48151623', expiresAt: Date.UTC(2026, 0, 1, 12, 5) };
    const createPairingCode = vi.fn(async () => code);
    setup({ api: { createPairingCode } });
    await devices().findAllByRole('listitem');
    expect(devices().getByText('void after 5 wrong attempts', { exact: false })).toBeDefined();
    expect(createPairingCode).not.toHaveBeenCalled();

    fireEvent.click(devices().getByRole('button', { name: 'Create pairing code' }));

    expect(await devices().findByText('48151623')).toBeDefined();
    expect(devices().getByText(/^Valid until .+\.$/)).toBeDefined();
    expect(createPairingCode).toHaveBeenCalledTimes(1);
  });

  test('with the maximum number of devices no code can be created', async () => {
    setup({
      api: {
        listDevices: async () => ({
          devices: [device('a', { current: true }), device('b')],
          maxDevices: 2,
        }),
      },
    });

    expect(
      await devices().findByText('The maximum number of devices is paired. Revoke one first.'),
    ).toBeDefined();
    expect(
      devices().getByRole<HTMLButtonElement>('button', { name: 'Create pairing code' }).disabled,
    ).toBe(true);
  });

  test('a device list that cannot be loaded is reported', async () => {
    const failure = new ApiError('network', 0, 'unreachable');
    const { services } = setup({ api: { listDevices: () => Promise.reject(failure) } });

    await waitFor(() => expect(services.errors).toEqual([failure]));
    expect(devices().queryAllByRole('listitem')).toEqual([]);
  });

  test('signing out goes through the shell; a failure is reported', async () => {
    const { services, onLogout } = setup();
    await devices().findAllByRole('listitem');

    fireEvent.click(devices().getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));

    const failure = new ApiError('network', 0, 'unreachable');
    onLogout.mockRejectedValueOnce(failure);
    await waitFor(() =>
      expect(devices().getByRole<HTMLButtonElement>('button', { name: 'Sign out' }).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(devices().getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(services.errors).toEqual([failure]));
  });
});

describe('connection security', () => {
  const tls = () => section('Connection security');
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

  test('the private CA can be downloaded, with install steps for each platform', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:ca';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const downloads: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ name: this.download, href: this.href });
    });
    setup({ server: serverInfo({ mode: 'auto', caCertificatePem: PEM }, ['https://wall.lan']) });

    expect(
      tls().getByText('its own private certificate authority', { exact: false }),
    ).toBeDefined();
    expect(tls().getByText('https://wall.lan')).toBeDefined();
    fireEvent.click(tls().getByRole('button', { name: `Download ${CA_FILE_NAME}` }));

    expect(downloads).toEqual([{ name: 'answerwall-ca.crt', href: 'blob:ca' }]);
    expect(await blobs[0]?.text()).toBe(PEM);
    expect(blobs[0]?.type).toBe('application/x-x509-ca-cert');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ca');
    expect(document.querySelector('a[download]')).toBeNull();

    const platforms = [...tls().getAllByRole('group')].map(
      (details) => details.querySelector('summary')?.textContent,
    );
    expect(platforms).toEqual(['Windows', 'macOS', 'iPhone and iPad', 'Android', 'Linux']);
    for (const details of tls().getAllByRole('group')) {
      const steps = within(details).getAllByRole('listitem');
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(details.textContent).toContain(CA_FILE_NAME);
      expect(details.textContent).not.toContain('{file}');
    }
  });

  test('a configured certificate needs no download', () => {
    setup({ server: serverInfo({ mode: 'cert' }) });

    expect(tls().getByText('the certificate configured for it', { exact: false })).toBeDefined();
    expect(tls().queryByRole('button', { name: /Download/ })).toBeNull();
    expect(tls().queryAllByRole('group')).toEqual([]);
  });

  test('plain HTTP on loopback or behind a proxy is explained without alarm', () => {
    setup({ server: serverInfo({ mode: 'off' }) });

    expect(tls().getByText('does not encrypt connections', { exact: false })).toBeDefined();
    expect(tls().queryByRole('alert')).toBeNull();
  });

  test('insecure mode is a warning', () => {
    setup({ server: serverInfo({ mode: 'off', insecure: true }) });

    expect(tls().getByRole('alert').textContent).toContain(
      'Unencrypted connections from other machines are allowed.',
    );
  });
});

describe('desktop mode', () => {
  test('has no devices section, since the desktop app never pairs devices', async () => {
    const { services } = setup({
      meta: {
        name: 'AnswerWall',
        version: '0.0.0-test',
        apiVersion: API_VERSION,
        mode: 'desktop',
        tls: 'off',
        authRequired: true,
      },
    });

    expect(section('About').getByText('Desktop app')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Devices' })).toBeNull();
    expect(services.apiCalls.map((call) => call.method)).not.toContain('listDevices');
  });
});

describe('about', () => {
  test('the server version and mode are shown, and providers are linked', () => {
    setup();

    expect(section('About').getByText('0.0.0-test')).toBeDefined();
    expect(section('About').getByText('Server')).toBeDefined();
    expect(screen.getByRole<HTMLAnchorElement>('link', { name: 'Providers' }).pathname).toBe(
      '/providers',
    );
  });
});
