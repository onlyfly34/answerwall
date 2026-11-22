import { render } from 'solid-js/web';
import { App } from './app/App.tsx';
import { ServicesContext } from './contracts/services.ts';
import { createServices } from './infra/services.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

const services = createServices();
render(
  () => (
    <ServicesContext.Provider value={services}>
      <App />
    </ServicesContext.Provider>
  ),
  root,
);
