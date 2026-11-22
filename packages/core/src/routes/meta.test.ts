import { expect, test } from 'vitest';
import { BRAND } from '../brand.ts';
import { API_PATHS, API_VERSION, MetaSchema } from '../protocol/index.ts';
import { createTestApp, createTestConfig } from '../testing/index.ts';

test('GET /api/meta describes the server without authentication', async () => {
  const { app } = createTestApp({
    config: createTestConfig({ version: '1.2.3', mode: 'desktop' }),
  });

  const response = await app.request(API_PATHS.meta);

  expect(response.status).toBe(200);
  expect(MetaSchema.parse(await response.json())).toEqual({
    name: BRAND.name,
    version: '1.2.3',
    apiVersion: API_VERSION,
    mode: 'desktop',
    tls: 'off',
    authRequired: true,
  });
});
