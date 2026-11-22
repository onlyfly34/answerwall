#!/usr/bin/env node
import { run } from './cli.ts';
import type { Runtime } from './cli.ts';

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
    return () => process.off(signal, handler);
  },
};

// Exit explicitly: after a timed-out shutdown something may still hold the event loop.
process.exit(await run(process.argv.slice(2), process.env, runtime));
