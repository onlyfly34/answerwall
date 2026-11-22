import type { Runtime } from './cli.ts';

/** The IPC message that stops the server like SIGTERM does. */
export const SHUTDOWN_MESSAGE = 'shutdown';

interface OutputStream {
  write(text: string): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  isTTY?: boolean;
}

/** The parts of `process` the server's command line uses; tests pass a stand-in. */
export interface HostProcess {
  stdout: OutputStream;
  stderr: OutputStream;
  /** Present when a supervisor started this process with an IPC channel. */
  channel?: { unref(): void } | undefined;
  on(event: string, listener: () => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: string, listener: (message: unknown) => void): unknown;
}

/**
 * Writes lines to `stream` until it fails, then drops them. A reader that
 * went away (a closed pipe, a closed terminal) reports through the stream's
 * `error` event after the write has returned; without a listener that event
 * would end the process before it could stop its child processes.
 */
function lineWriter(stream: OutputStream): (line: string) => void {
  let open = true;
  stream.on('error', () => {
    open = false;
  });
  return (line) => {
    if (!open) return;
    try {
      stream.write(`${line}\n`);
    } catch {
      open = false;
    }
  };
}

/**
 * Connects the command line to the real process: output that survives a
 * closed stream, signals, and the shutdown requests of a supervisor.
 * @param killChildren see {@link Runtime.killChildren}; also run when the process exits.
 */
export function createProcessRuntime(host: HostProcess, killChildren?: () => void): Runtime {
  // No exit, however it comes about, may leave a child process behind.
  if (killChildren) host.on('exit', killChildren);

  /** Set by the first request to stop, whichever way it arrived. */
  let stopRequested = false;

  return {
    stdout: lineWriter(host.stdout),
    stderr: lineWriter(host.stderr),
    stdoutIsTty: host.stdout.isTTY === true,
    ...(killChildren ? { killChildren } : {}),
    onSignal: (signal, handler) => {
      const onSignal = (): void => {
        stopRequested = true;
        handler();
      };
      // Windows cannot deliver SIGTERM to another process. A supervisor that
      // started this one with an IPC channel sends the message `shutdown` instead.
      const onMessage = (message: unknown): void => {
        if (message === SHUTDOWN_MESSAGE) onSignal();
      };
      // A supervisor that is gone can no longer stop the server, so its
      // disappearance does. It only ever starts a shutdown: a supervisor that
      // asks for one and then exits must not cut it short like a second signal.
      const onDisconnect = (): void => {
        if (!stopRequested) onSignal();
      };

      host.on(signal, onSignal);
      if (signal === 'SIGTERM' && host.channel !== undefined) {
        host.on('message', onMessage);
        host.on('disconnect', onDisconnect);
        host.channel.unref();
      }
      return () => {
        host.off(signal, onSignal);
        host.off('message', onMessage);
        host.off('disconnect', onDisconnect);
      };
    },
  };
}
