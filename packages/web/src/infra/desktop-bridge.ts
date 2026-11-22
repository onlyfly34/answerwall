import { DESKTOP_BRIDGE_GLOBAL, LoginTerminalResultSchema } from '@answerwall/core/protocol';
import type { DesktopBridge } from '@answerwall/core/protocol';

/**
 * The desktop shell's bridge, when this page runs in the shell's local
 * window; `undefined` in a browser and in a window that shows a remote
 * server. What the shell answers is checked like any other input.
 */
export function desktopBridge(): DesktopBridge | undefined {
  const candidate = (window as unknown as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL];
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const { openLoginTerminal } = candidate as Partial<DesktopBridge>;
  if (typeof openLoginTerminal !== 'function') return undefined;
  return {
    async openLoginTerminal(kind) {
      const answer = LoginTerminalResultSchema.safeParse(await openLoginTerminal(kind));
      return answer.success ? answer.data : { ok: false, reason: 'no_terminal' };
    },
  };
}
