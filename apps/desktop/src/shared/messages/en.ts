/** The desktop shell's own strings: menus, dialogs and the connection page. */
export const en = {
  'connection.title': 'Connection',
  'connection.intro': 'Choose where the answers come from. You can change this later in the menu.',
  'connection.local.title': 'This computer',
  'connection.local.help':
    'Uses the AI command-line tools installed on this computer. Nothing is reachable from other devices.',
  'connection.remote.title': 'A server',
  'connection.remote.help':
    'Shows the web interface of a {name} server you run elsewhere. You pair this app as a device on the page that opens.',
  'connection.remote.url': 'Server address',
  'connection.remote.check': 'Check',
  'connection.remote.checking': 'Checking…',
  'connection.remote.found': 'Found {name} {version} (protocol version {apiVersion}).',
  'connection.remote.apiMismatch':
    'The server speaks protocol version {server}; this app was built for version {app}. The window shows the server’s own interface, so it works anyway. Update whichever is older.',
  'connection.remote.versionMismatch':
    'The server is version {server}; this app is version {app}. The window shows the server’s own interface.',
  'connection.remote.insecure':
    'This address uses plain HTTP: everything, your sign-in included, crosses the network unencrypted. It is allowed only for this computer and for private network addresses.',
  'connection.remote.certificateHelp':
    'Certificate errors are never bypassed. A server with a private certificate authority works once its CA certificate is installed in Windows (Trusted Root Certification Authorities).',
  'connection.continue': 'Continue',
  'connection.working': 'Connecting…',
  'connection.problem.saved': 'The saved connection did not work.',
  'connection.updateCheck': 'Check for updates when the app starts',
  'connection.updateCheck.help':
    'Reads only this project’s releases on GitHub. Nothing is downloaded or installed without asking.',
  'connection.updateCheck.unsupported': 'This build does not update itself.',
  'connection.version': 'Version {version}',

  'problem.url.empty': 'Enter the address of the server.',
  'problem.url.invalid': 'This is not a valid address. Example: https://wall.example.com',
  'problem.url.scheme': 'The address must start with https:// or http://.',
  'problem.url.credentials': 'The address must not contain a user name or a password.',
  'problem.url.path':
    'Enter only the server’s origin, without a path: https://wall.example.com or https://wall.example.com:7717',
  'problem.url.insecure_public':
    'Plain HTTP is allowed only for this computer and for private network addresses. Use https:// for this server.',
  'problem.url.unresolved':
    'The name could not be resolved, so it is unknown whether plain HTTP is safe for it. Check the name or use https://.',
  'problem.unreachable':
    'The server did not answer. Check the address and that the server is running.',
  'problem.certificate':
    'The server’s certificate is not trusted by this computer. Certificate errors are never bypassed: install the server’s CA certificate in Windows (Trusted Root Certification Authorities), then try again.',
  'problem.timeout': 'The server took too long to answer.',
  'problem.not_a_server':
    'Something answered at this address, but it is not a server running {name}.',
  'problem.desktop_instance':
    'This address belongs to a desktop app running {name}. It serves only its own window; connect to a server instead.',
  'problem.local_failed':
    'The local server could not be started. The log folder (Help menu) has the details.',

  'menu.file': 'File',
  'menu.connection': 'Connection…',
  'menu.checkUpdates': 'Check for Updates…',
  'menu.quit': 'Quit',
  'menu.edit': 'Edit',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select All',
  'menu.view': 'View',
  'menu.reload': 'Reload',
  'menu.zoomIn': 'Zoom In',
  'menu.zoomOut': 'Zoom Out',
  'menu.resetZoom': 'Actual Size',
  'menu.fullscreen': 'Toggle Full Screen',
  'menu.devTools': 'Developer Tools',
  'menu.help': 'Help',
  'menu.about': 'About {name}',
  'menu.licences': 'Licences',
  'menu.openLogs': 'Open the Log Folder',

  'button.ok': 'OK',
  'button.later': 'Later',
  'button.quit': 'Quit',

  'about.detail':
    'Version {version}\nElectron {electron}, Chromium {chrome}, Node.js {node}\n\nMIT licence. The licences of the bundled software are under Help > Licences.\n{repository}',

  'update.none': 'You have the latest version.',
  'update.none.detail': 'Version {version}',
  'update.available': 'Version {version} is available.',
  'update.available.detail':
    'You have version {current}. Download it now? Nothing is installed without asking again.\n\nThe installer is not code-signed. The download is checked against the checksum published with the release on GitHub.',
  'update.download': 'Download',
  'update.downloaded': 'Version {version} has been downloaded.',
  'update.downloaded.detail':
    'Install it now? The app closes, answers that are still running are stopped, and the installer starts.',
  'update.install': 'Install and Restart',
  'update.failed': 'The update check failed.',
  'update.installFailed': 'The update could not be installed.',
  'update.installFailed.detail':
    'The installer did not start, so the app keeps running in the version you have. Answers that were running were stopped. You can try again with File > Check for Updates.',
  'update.unsupported': 'This build does not update itself.',
  'update.unsupported.detail': 'Updates are installed by the Windows installer of a release.',
  'update.disabled.detail': 'Updates are switched off by {variable}.',

  'core.crashed': 'The local server stopped unexpectedly.',
  'core.crashed.detail':
    'Answers that were running are lost. The log folder (Help menu) has the details.',
  'core.restart': 'Restart It',
  'window.crashed': 'The window stopped working.',
  'window.reload': 'Reload',
  'fatal.title': '{name} has to close',
  'fatal.detail': 'An unexpected error occurred. The log folder has the details:\n{logs}',
  'title.insecure': 'not encrypted',
  'terminal.title': '{name}: log in',
} as const;
