import type { MenuItemConstructorOptions } from 'electron';
import { APP } from '../shared/app-info.ts';
import type { Translate } from '../shared/messages/index.ts';

export interface MenuActions {
  openConnection: () => void;
  checkForUpdates: () => void;
  about: () => void;
  licences: () => void;
  openLogs: () => void;
  quit: () => void;
}

/** The application menu. Labels are spelled out: role labels are not translated on Windows. */
export function menuTemplate(
  t: Translate,
  actions: MenuActions,
  options: { devTools: boolean },
): MenuItemConstructorOptions[] {
  return [
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.connection'), accelerator: 'CmdOrCtrl+,', click: actions.openConnection },
        { label: t('menu.checkUpdates'), click: actions.checkForUpdates },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: actions.quit },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { label: t('menu.undo'), role: 'undo' },
        { label: t('menu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('menu.cut'), role: 'cut' },
        { label: t('menu.copy'), role: 'copy' },
        { label: t('menu.paste'), role: 'paste' },
        { label: t('menu.selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), role: 'reload' },
        { type: 'separator' },
        { label: t('menu.zoomIn'), role: 'zoomIn' },
        { label: t('menu.zoomOut'), role: 'zoomOut' },
        { label: t('menu.resetZoom'), role: 'resetZoom' },
        { type: 'separator' },
        { label: t('menu.fullscreen'), role: 'togglefullscreen' },
        ...(options.devTools
          ? ([{ label: t('menu.devTools'), role: 'toggleDevTools' }] as const)
          : []),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.about', { name: APP.name }), click: actions.about },
        { label: t('menu.licences'), click: actions.licences },
        { label: t('menu.openLogs'), click: actions.openLogs },
      ],
    },
  ];
}
