#!/usr/bin/env node
import { killChildProcessTrees } from '@answerwall/core';
import { run } from './cli.ts';
import { createProcessRuntime } from './process-runtime.ts';

const runtime = createProcessRuntime(process, killChildProcessTrees);

// Exit explicitly: after a timed-out shutdown something may still hold the event loop.
process.exit(await run(process.argv.slice(2), process.env, runtime));
