#!/usr/bin/env node
import { createServer } from '@answerwall/core';
import { loadConfig } from './config.ts';

const server = await createServer(loadConfig(process.env));
const { url } = await server.listen();
server.logger.info('listening', { url });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.logger.info('shutting down', { signal });
    void server.shutdown().then(() => process.exit(0));
  });
}
