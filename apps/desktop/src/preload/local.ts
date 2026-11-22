/**
 * Preload of the local window. It gives the page exactly one action: ask the
 * main process to open a terminal for one CLI's login. The page passes a
 * provider kind; the main process looks the command up in its fixed table
 * and refuses anything else. Nothing of Electron or Node reaches the page,
 * and neither does the launch token, which this script never sees either.
 */
import { contextBridge, ipcRenderer } from 'electron';
// The brand module alone: a preload stays small, and this one runs on every page load.
import { BRAND } from '@answerwall/core/brand';
import type { DesktopBridge, LoginTerminalResult } from '@answerwall/core/protocol';
import { CHANNELS } from '../shared/ipc.ts';

const bridge: DesktopBridge = {
  openLoginTerminal: (kind) =>
    ipcRenderer.invoke(CHANNELS.openLoginTerminal, kind) as Promise<LoginTerminalResult>,
};

contextBridge.exposeInMainWorld(BRAND.desktopBridge, bridge);
