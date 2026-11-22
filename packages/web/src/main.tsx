// First: it configures the validation library before any module builds a schema.
import './infra/zod-config.ts';
import { render } from 'solid-js/web';
import { App } from './app/App.tsx';
import { ShellContext } from './app/shell-context.ts';
import { ServicesContext } from './contracts/services.ts';
import './contracts/theme.css';
import './app/app.css';
import { createServices } from './infra/services.ts';
import { registerServiceWorker } from './pwa/updater.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

const services = createServices();
render(
  () => (
    <ServicesContext.Provider value={services}>
      <ShellContext.Provider value={services}>
        <App />
      </ShellContext.Provider>
    </ServicesContext.Provider>
  ),
  root,
);
registerServiceWorker();
