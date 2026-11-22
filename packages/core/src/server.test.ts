import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BRAND } from './brand.ts';
import { API_PATHS, MetaSchema } from './protocol/index.ts';
import { createServer } from './server.ts';
import type { ServerHandle } from './server.ts';
import { createMemoryLogger, createTestConfig } from './testing/index.ts';

let server: ServerHandle | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.shutdown();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('the server starts on a free port, serves meta over HTTP and shuts down', async () => {
  dataDir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-`));
  server = await createServer(createTestConfig({ dataDir }), { logger: createMemoryLogger() });

  const { url, port } = await server.listen();

  expect(port).toBeGreaterThan(0);
  const response = await fetch(new URL(API_PATHS.meta, url));
  expect(MetaSchema.parse(await response.json()).name).toBe(BRAND.name);
});
