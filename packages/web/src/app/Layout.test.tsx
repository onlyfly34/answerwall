import { createSignal } from 'solid-js';
import type { Component, JSX } from 'solid-js';
import { MemoryRouter, Route } from '@solidjs/router';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, expect, test, vi } from 'vitest';
import { ServicesContext } from '../contracts/services.ts';
import { createServices } from '../infra/services.ts';
import { fakeVisibility, memoryStorage, scriptedFetch } from '../infra/test-support.ts';
import { Layout } from './Layout.tsx';
import { ShellContext } from './shell-context.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderInLayout(page: () => JSX.Element): void {
  const services = createServices({
    fetch: scriptedFetch(() => new Response(null, { status: 500 })).fetch,
    updater: { apply: async () => true, settled: () => undefined },
    visibility: fakeVisibility(),
    language: { storage: memoryStorage(), preferred: ['en'], root: { lang: '' } },
  });
  render(() => (
    <ServicesContext.Provider value={services}>
      <ShellContext.Provider value={services}>
        <MemoryRouter>
          <Route path="*" component={() => <Layout>{page()}</Layout>} />
        </MemoryRouter>
      </ShellContext.Provider>
    </ServicesContext.Provider>
  ));
}

test('a page that throws is replaced by an explanation; the navigation keeps working', () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const [broken, setBroken] = createSignal(true);
  const defect = new Error('render failed');
  const FlakyPage: Component = () => {
    if (broken()) throw defect;
    return <h1>Recovered page</h1>;
  };
  renderInLayout(() => <FlakyPage />);

  expect(screen.getByRole('heading', { name: 'This page stopped working' })).toBeDefined();
  expect(screen.getByText('Your asks keep running on the server.', { exact: false })).toBeDefined();
  expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined();
  expect(logged).toHaveBeenCalledWith(defect);

  setBroken(false);
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(screen.getByRole('heading', { name: 'Recovered page' })).toBeDefined();
});

test('the page content is a focusable main landmark', () => {
  renderInLayout(() => <p>content</p>);

  const main = screen.getByRole('main');
  expect(main.getAttribute('tabindex')).toBe('-1');
  expect(main.textContent).toContain('content');
});
