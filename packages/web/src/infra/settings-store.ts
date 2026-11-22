import { batch, createSignal } from 'solid-js';
import type {
  ServerInfo,
  Settings,
  SettingsPatch,
  SettingsResponse,
} from '@answerwall/core/protocol';
import type { ApiClient, SettingsStore } from '../contracts/services.ts';

export interface SettingsStoreDeps {
  api: Pick<ApiClient, 'getSettings' | 'updateSettings'>;
  /** After every load and update, with the patch that caused it (none for a load). */
  onChange?(settings: Settings, patch?: SettingsPatch): void;
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const [settings, setSettings] = createSignal<Settings>();
  const [server, setServer] = createSignal<ServerInfo>();

  function accept(response: SettingsResponse, patch?: SettingsPatch): void {
    batch(() => {
      setSettings(response.settings);
      setServer(response.server);
    });
    deps.onChange?.(response.settings, patch);
  }

  return {
    settings,
    server,
    async load() {
      accept(await deps.api.getSettings());
    },
    async update(patch) {
      accept(await deps.api.updateSettings(patch), patch);
    },
  };
}
