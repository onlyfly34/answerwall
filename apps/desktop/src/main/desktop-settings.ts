/**
 * What the shell itself remembers between launches, in one small JSON file
 * in the user data directory. Nothing secret: the remote session lives in
 * the remote window's own cookie store, API keys in the secret store.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConnectionMode } from '../shared/ipc.ts';

export interface DesktopSettings {
  /** `undefined` until the user has chosen: the connection page is shown. */
  mode: ConnectionMode | undefined;
  /** The origin of the remote server last connected to; kept when switching to local. */
  remoteUrl: string | undefined;
  /**
   * The port the local server had last time. It is tried again so that the
   * page keeps its origin, and with it what the browser stores per origin
   * (the wall's arrangement, the language). Chosen by the system at first.
   */
  localPort: number | undefined;
  /**
   * Mirror of the "check for updates" setting, which lives in the local
   * server's settings. Used when no local server runs (remote mode).
   */
  updateCheck: boolean;
  /** The mirror was changed while no local server ran and still has to be written to it. */
  updateCheckPending: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  mode: undefined,
  remoteUrl: undefined,
  localPort: undefined,
  updateCheck: true,
  updateCheckPending: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a stored document field by field; anything missing or malformed becomes the default. */
export function repairDesktopSettings(document: unknown): DesktopSettings {
  const fields = isRecord(document) ? document : {};
  const { mode, remoteUrl, localPort, updateCheck, updateCheckPending } = fields;
  const remote =
    typeof remoteUrl === 'string' && /^https?:\/\/[^/\s]+$/.test(remoteUrl) ? remoteUrl : undefined;
  return {
    // Remote without an address is not a choice that can be opened.
    mode: mode === 'local' || (mode === 'remote' && remote !== undefined) ? mode : undefined,
    remoteUrl: remote,
    localPort:
      typeof localPort === 'number' &&
      Number.isInteger(localPort) &&
      localPort >= 1024 &&
      localPort <= 65535
        ? localPort
        : undefined,
    updateCheck:
      typeof updateCheck === 'boolean' ? updateCheck : DEFAULT_DESKTOP_SETTINGS.updateCheck,
    updateCheckPending: updateCheckPending === true,
  };
}

/** The file system calls the store makes; tests pass an in-memory stand-in. */
export interface SettingsFiles {
  read(file: string): string | undefined;
  /** Replaces the file in one step, so a crash never leaves half a document. */
  write(file: string, content: string): void;
}

export const diskFiles: SettingsFiles = {
  read(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  write(file, content) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, file);
  },
};

export interface DesktopSettingsStore {
  get(): DesktopSettings;
  /** Applies the changed fields and writes the file. */
  update(patch: Partial<DesktopSettings>): DesktopSettings;
}

export function createDesktopSettingsStore(
  file: string,
  files: SettingsFiles = diskFiles,
): DesktopSettingsStore {
  let current: DesktopSettings;
  try {
    current = repairDesktopSettings(JSON.parse(files.read(file) ?? 'null'));
  } catch {
    // A damaged file is the same as none: the user is asked again.
    current = { ...DEFAULT_DESKTOP_SETTINGS };
  }
  return {
    get: () => ({ ...current }),
    update(patch) {
      // Through the repair, so that the file never holds what a read would reject.
      current = repairDesktopSettings({ ...current, ...patch });
      files.write(file, `${JSON.stringify({ version: 1, ...current }, null, 2)}\n`);
      return { ...current };
    },
  };
}
