/**
 * Preload of the bundled connection page: four calls to the main process,
 * each validated there again. Nothing of Electron or Node reaches the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { APP } from '../shared/app-info.ts';
import { CHANNELS } from '../shared/ipc.ts';
import type {
  ApplyResult,
  ConnectionApi,
  ConnectionState,
  RemoteCheckResult,
} from '../shared/ipc.ts';

const api: ConnectionApi = {
  state: () => ipcRenderer.invoke(CHANNELS.connectionState) as Promise<ConnectionState>,
  check: (url) => ipcRenderer.invoke(CHANNELS.connectionCheck, url) as Promise<RemoteCheckResult>,
  apply: (choice) => ipcRenderer.invoke(CHANNELS.connectionApply, choice) as Promise<ApplyResult>,
  setUpdateCheck: (enabled) =>
    ipcRenderer.invoke(CHANNELS.connectionSetUpdateCheck, enabled) as Promise<void>,
};

contextBridge.exposeInMainWorld(APP.connectionGlobal, api);
