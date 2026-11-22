import { z } from 'zod';
import { BRAND } from '../brand.ts';
import type { CliProviderKind } from './providers.ts';

/**
 * The one thing the desktop shell offers the page of its local server: an
 * object on `window` under this name, put there by the shell's preload
 * script. It does not exist in a browser or in a window that shows a remote
 * server.
 */
export const DESKTOP_BRIDGE_GLOBAL = BRAND.desktopBridge;

/** `no_terminal`: no terminal program could be started on this system. */
export const LoginTerminalResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(['unknown_provider', 'no_terminal']) }),
]);
export type LoginTerminalResult = z.infer<typeof LoginTerminalResultSchema>;

export interface DesktopBridge {
  /**
   * Opens a system terminal window that runs the official login command of
   * this CLI (`LOGIN_COMMANDS`). The page names the kind, never a command;
   * the app does not see what happens in the terminal.
   */
  openLoginTerminal(kind: CliProviderKind): Promise<LoginTerminalResult>;
}
