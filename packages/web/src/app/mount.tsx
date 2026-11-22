import { render } from 'solid-js/web';
import { ServicesContext } from '../contracts/services.ts';
import '../contracts/theme.css';
import type { ShellServices } from '../infra/services.ts';
import { App } from './App.tsx';
import './app.css';
import { ShellContext } from './shell-context.ts';

/** Renders the app into `root`; the returned function removes it again. */
export function mountApp(root: HTMLElement, services: ShellServices): () => void {
  return render(
    () => (
      <ServicesContext.Provider value={services}>
        <ShellContext.Provider value={services}>
          <App />
        </ShellContext.Provider>
      </ServicesContext.Provider>
    ),
    root,
  );
}
