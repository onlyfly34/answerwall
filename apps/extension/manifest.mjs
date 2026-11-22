// The manifest of the extension, as data: what it may do is exactly what is
// written here. `build.mjs` writes it into the build; a unit test pins the
// permission list.

/**
 * The public half of a key pair whose private half was discarded when it was
 * generated. Its only purpose is to give the unpacked extension the same ID
 * in every folder and on every machine, so that the ID a user lists on the
 * server (Settings > Web cells) does not depend on where the zip was
 * unpacked. It authenticates nothing: anyone can load an extension with this
 * key, which is why the server also requires pairing.
 */
export const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo5XvjtjOPov1oSrofHbozpxgketTz9aZc5peXa2B7684a2A7doLSyXjogwwqRN22jwdTZZyygpxB4ZJb976JqmZru3G6Rmmq8tn7J/Hfx9sVqYW9SED94dkmdZ85GXFU1C5+Jk9/bJV0TIkNcf12iA1wu45HQHI4baDF4j8EFkjfeUudcBvKihgSb8UQBXzpX6HBDkIdt/usS6UCWzUKwSM5vDQ6IiA35VPa2G9VXCJYa7EkBC5zP7+24cAynqamGWVjzr/01eSytcGCSHNYib+dqo50eKsd0CNB1Vu8lyYQ43IkWIeBChN741s20RcS+KqeQCIBTMF0MRrCD5QbtwIDAQAB';

/** The ID Chromium derives from {@link PUBLIC_KEY}. */
export const EXTENSION_ID = 'nffcmlcjkacklpololkpdmhcfokannom';

/** Oldest Chrome the extension is written for (`runtime.getContexts`, session rules with `tabIds`). */
export const MINIMUM_CHROME_VERSION = '116';

/**
 * Chrome's `version` is up to four numbers; a pre-release suffix goes into
 * `version_name`, which is what the extensions page shows.
 */
export function chromeVersion(version) {
  const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!numbers) throw new Error(`"${version}" is not a version`);
  return `${numbers[1]}.${numbers[2]}.${numbers[3]}`;
}

/**
 * The content security policy of the extension's pages. It is the policy the
 * server sends for the same web UI (DECISIONS section 7), with what the wall
 * page needs on top:
 * - `connect-src http: https:` — the server is at an address the user
 *   enters, so it cannot be named here. Which host is reached is decided by
 *   the host permission the user grants and by the page's own connection,
 *   which refuses every other origin.
 * - `frame-src https:` — the vendors' sites in the cells, and wherever their
 *   sign-in sends the frame.
 * Everything else stays closed: no remote script, image, style, font or
 * media, no plugin, no `<base>`, and no form that posts anywhere.
 *
 * @param {{ host: string } | undefined} [test] the test build also frames the stand-in site, over http
 */
export function contentSecurityPolicy(test) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    'connect-src http: https:',
    `frame-src https:${test ? ` http://${test.host}:*` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * @param {object} options
 * @param {string} options.name          the product name
 * @param {string} options.version       the workspace version
 * @param {string[]} options.hosts       the vendor hosts of the site rules
 * @param {{ host: string, serverPattern: string } | undefined} [options.test]
 *   the test build: the stand-in site's host is framed like a vendor host (over
 *   http), and the loopback server needs no permission prompt, which a test
 *   cannot answer
 */
export function buildManifest({ name, version, hosts, test }) {
  const sites = [
    ...hosts.map((host) => `https://${host}/*`),
    ...(test ? [`http://${test.host}/*`] : []),
  ];
  return {
    manifest_version: 3,
    name: test ? `${name} web cells (test build)` : `${name} web cells`,
    description:
      'Shows the web apps you are signed in to next to the other cells of your AnswerWall server.',
    version: chromeVersion(version),
    version_name: version,
    minimum_chrome_version: MINIMUM_CHROME_VERSION,
    key: PUBLIC_KEY,
    icons: { 48: 'icon-192.png', 128: 'icon-192.png' },
    action: { default_title: `Open the ${name} wall` },
    background: { service_worker: 'worker.js' },
    content_security_policy: { extension_pages: contentSecurityPolicy(test) },
    // declarativeNetRequestWithHostAccess: header rules only for hosts the
    // extension has host permission for. storage: the server's address and
    // the device token. Nothing else: no cookies, no webRequest, no tabs, no
    // scripting, no <all_urls>.
    permissions: ['declarativeNetRequestWithHostAccess', 'storage'],
    host_permissions: [...sites, ...(test ? [test.serverPattern] : [])],
    // Not granted at installation. The wall page asks for the one origin of
    // the server the user enters, and the browser shows that request.
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    content_scripts: [
      {
        matches: sites,
        js: ['content.js'],
        all_frames: true,
        run_at: 'document_idle',
      },
    ],
  };
}
