/**
 * The connection page: choose between this computer and a server, check a
 * server's address, and say whether the app looks for updates. Plain DOM; it
 * talks to the main process only through the four calls of its preload.
 */
import { APP } from '../shared/app-info.ts';
import type {
  ConnectionApi,
  ConnectionProblem,
  ConnectionState,
  RemoteCheckResult,
} from '../shared/ipc.ts';
import { format } from '../shared/messages/index.ts';
import type { MessageKey, Translate } from '../shared/messages/index.ts';

const api = (window as unknown as Record<string, ConnectionApi>)[APP.connectionGlobal];

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing`);
  return found as T;
}

/** The message for a problem, in the page's language. */
export function problemMessage(problem: ConnectionProblem, t: Translate): string {
  const key: MessageKey =
    problem.kind === 'url' ? `problem.url.${problem.detail}` : `problem.${problem.kind}`;
  return t(key, { name: APP.name });
}

function show(node: HTMLElement, text: string, kind: 'ok' | 'warning' | 'error'): void {
  node.textContent = text;
  node.classList.toggle('is-warning', kind === 'warning');
  node.classList.toggle('is-error', kind === 'error');
  node.hidden = false;
}

async function start(connection: ConnectionApi): Promise<void> {
  const state: ConnectionState = await connection.state();
  const t: Translate = (key, params) => format(state.messages[key], params);

  document.documentElement.lang = state.language;
  document.title = `${APP.name}: ${t('connection.title')}`;
  for (const node of document.querySelectorAll<HTMLElement>('[data-t]')) {
    node.textContent = t(node.dataset['t'] as MessageKey, { name: APP.name });
  }

  const form = element<HTMLFormElement>('form');
  const modes = [...form.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  const remoteFields = element('remote-fields');
  const url = element<HTMLInputElement>('url');
  const check = element<HTMLButtonElement>('check');
  const insecure = element('insecure');
  const result = element('check-result');
  const problem = element('problem');
  const updateCheck = element<HTMLInputElement>('update-check');
  const submit = element<HTMLButtonElement>('continue');

  const selected = (): string | undefined => modes.find((mode) => mode.checked)?.value;
  const refresh = (): void => {
    remoteFields.hidden = selected() !== 'remote';
    insecure.hidden = !/^\s*http:\/\//i.test(url.value);
    submit.disabled = selected() === undefined;
  };

  for (const mode of modes) {
    mode.checked = mode.value === state.mode;
    mode.addEventListener('change', refresh);
  }
  url.value = state.remoteUrl;
  url.addEventListener('input', () => {
    result.hidden = true;
    refresh();
  });

  element('version').textContent = t('connection.version', { version: state.appVersion });
  updateCheck.checked = state.updateCheck;
  updateCheck.disabled = !state.updatesSupported;
  element('update-help').textContent = t(
    state.updatesSupported ? 'connection.updateCheck.help' : 'connection.updateCheck.unsupported',
  );
  updateCheck.addEventListener('change', () => {
    void connection.setUpdateCheck(updateCheck.checked);
  });

  if (state.problem) {
    show(problem, `${t('connection.problem.saved')} ${problemMessage(state.problem, t)}`, 'error');
  }

  const report = (checked: RemoteCheckResult): void => {
    if (!checked.ok) {
      show(result, problemMessage(checked.problem, t), 'error');
      return;
    }
    const { server } = checked;
    const lines = [
      t('connection.remote.found', {
        name: server.name,
        version: server.version,
        apiVersion: server.apiVersion,
      }),
    ];
    if (server.apiMismatch) {
      lines.push(
        t('connection.remote.apiMismatch', { server: server.apiVersion, app: state.apiVersion }),
      );
    } else if (server.versionMismatch) {
      lines.push(
        t('connection.remote.versionMismatch', { server: server.version, app: state.appVersion }),
      );
    }
    show(result, lines.join('\n'), server.apiMismatch ? 'warning' : 'ok');
    insecure.hidden = !server.insecure;
  };

  let busy = false;
  const working = (on: boolean, label: MessageKey): void => {
    busy = on;
    check.disabled = on;
    submit.disabled = on || selected() === undefined;
    submit.textContent = t(on ? label : 'connection.continue');
  };

  check.addEventListener('click', () => {
    if (busy) return;
    working(true, 'connection.remote.checking');
    void connection
      .check(url.value)
      .then(report)
      .finally(() => working(false, 'connection.continue'));
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const mode = selected();
    if (busy || mode === undefined) return;
    problem.hidden = true;
    working(true, 'connection.working');
    void connection
      .apply(mode === 'remote' ? { mode: 'remote', url: url.value } : { mode: 'local' })
      .then((applied) => {
        // On success the main process closes this window.
        if (applied.ok) return;
        const target = mode === 'remote' ? result : problem;
        show(target, problemMessage(applied.problem, t), 'error');
        if (mode === 'remote') url.focus();
      })
      .finally(() => working(false, 'connection.continue'));
  });

  refresh();
  document.querySelector('main')?.removeAttribute('hidden');
  (selected() === 'remote' ? url : (modes.find((mode) => mode.checked) ?? modes[0]))?.focus();
}

if (api) void start(api);
