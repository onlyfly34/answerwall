import { BRAND } from '@answerwall/core/brand';

const [owner = '', repository = ''] = new URL(BRAND.repository).pathname.split('/').filter(Boolean);

/** Everything name-derived in the desktop shell; the name itself lives in core's brand module. */
export const APP = {
  name: BRAND.name,
  slug: BRAND.slug,
  /** Windows application id: installer, taskbar grouping. */
  id: `io.github.${owner}.${BRAND.slug}`,
  /** The one repository whose releases the updater reads. */
  repository: { owner, name: repository, url: BRAND.repository },
  /** Environment variables the shell itself understands. */
  env: {
    /** `off` disables the updater entirely, whatever the settings say. */
    updates: `${BRAND.envPrefix}DESKTOP_UPDATES`,
  },
  /** Session partitions: one per kind of content, so nothing is shared between them. */
  partitions: {
    local: 'persist:local',
    remote: 'persist:remote',
    /** In memory only: the bundled connection page keeps nothing. */
    connection: 'connection',
  },
  /** What the connection page's preload exposes on `window`. */
  connectionGlobal: `${BRAND.slug}Connection`,
} as const;
