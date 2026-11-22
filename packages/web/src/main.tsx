// First: it configures the validation library before any module builds a schema.
import './infra/zod-config.ts';
import { mountApp } from './app/mount.tsx';
import { createServices } from './infra/services.ts';
import { registerServiceWorker } from './pwa/updater.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

mountApp(root, createServices());
registerServiceWorker();
