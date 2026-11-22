/** Renders one page the way the shell does: inside the services and a router. Tests only. */
import type { JSX } from 'solid-js';
import { MemoryRouter, Route } from '@solidjs/router';
import { render } from '@solidjs/testing-library';
import { ServicesContext } from '../contracts/services.ts';
import type { AppServices } from '../contracts/services.ts';

export function renderPage(page: () => JSX.Element, services: AppServices): void {
  render(() => (
    <ServicesContext.Provider value={services}>
      <MemoryRouter>
        <Route path="*" component={() => page()} />
      </MemoryRouter>
    </ServicesContext.Provider>
  ));
}

/** Types into a field the way a user does: the value changes, then the field is left. */
export function setValue(field: HTMLElement, value: string): void {
  const input = field as HTMLInputElement | HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
