#!/usr/bin/env node
import { run } from './cli.ts';
import type { Runtime } from './cli.ts';

/** The IPC message that stops the server like SIGTERM does. */
const SHUTDOWN_MESSAGE = 'shutdown';

const writeLine = (stream: NodeJS.WriteStream) => (line: string) => {
  try {
    stream.write(`${line}\n`);
  } catch {
    // A closed pipe must not take the server down.
  }
};

const runtime: Runtime = {
  stdout: writeLine(process.stdout),
  stderr: writeLine(process.stderr),
  stdoutIsTty: process.stdout.isTTY === true,
  onSignal: (signal, handler) => {
    process.on(signal, handler);
    // Windows cannot deliver SIGTERM to another process. A supervisor that
    // started this one with an IPC channel sends the message `shutdown` instead.
    const onMessage = (message: unknown): void => {
      if (message === SHUTDOWN_MESSAGE) handler();
    };
    if (signal === 'SIGTERM' && process.channel !== undefined) {
      process.on('message', onMessage);
      process.channel.unref();
    }
    return () => {
      process.off(signal, handler);
      process.off('message', onMessage);
    };
  },
};

// Exit explicitly: after a timed-out shutdown something may still hold the event loop.
process.exit(await run(process.argv.slice(2), process.env, runtime));
