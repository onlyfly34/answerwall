import { createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { BREAKPOINTS } from '../../contracts/theme.ts';
import type { Viewport } from './layout.ts';

export function viewportOfWidth(width: number): Viewport {
  if (width <= BREAKPOINTS.phoneMaxWidth) return 'phone';
  if (width <= BREAKPOINTS.tabletMaxWidth) return 'tablet';
  return 'desktop';
}

/** The viewport class, kept current. Call inside a component. */
export function createViewport(): Accessor<Viewport> {
  const [viewport, setViewport] = createSignal(viewportOfWidth(window.innerWidth));
  const update = (): void => void setViewport(viewportOfWidth(window.innerWidth));
  window.addEventListener('resize', update);
  onCleanup(() => window.removeEventListener('resize', update));
  return viewport;
}
