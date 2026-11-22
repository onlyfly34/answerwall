import { render, screen } from '@solidjs/testing-library';
import { expect, test } from 'vitest';
import { API_VERSION } from '@answerwall/core/protocol';
import type { Meta } from '@answerwall/core/protocol';
import { ServicesContext } from '../contracts/services.ts';
import { createApiClient } from '../infra/api.ts';
import { createServices } from '../infra/services.ts';
import { App } from './App.tsx';

const meta: Meta = {
  name: 'Product Name From Server',
  version: '9.9.9',
  apiVersion: API_VERSION,
  mode: 'server',
  tls: 'off',
  authRequired: true,
};

test('the page shows the product name it fetched from /api/meta', async () => {
  const requested: string[] = [];
  const api = createApiClient(async (input) => {
    if (typeof input === 'string') requested.push(input);
    return Response.json(meta);
  });

  const services = createServices(api);

  render(() => (
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>
  ));

  expect(await screen.findByRole('heading', { name: meta.name })).toBeDefined();
  expect(screen.getByText('Under construction — version 9.9.9')).toBeDefined();
  expect(requested).toEqual(['/api/meta']);
});
