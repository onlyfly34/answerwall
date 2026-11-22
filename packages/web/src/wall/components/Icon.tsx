import type { Component } from 'solid-js';

const PATHS = {
  grip: 'M6 4h1.5v1.5H6zM6 7.25h1.5v1.5H6zM6 10.5h1.5V12H6zM9.5 4H11v1.5H9.5zM9.5 7.25H11v1.5H9.5zM9.5 10.5H11V12H9.5z',
  duplicate: 'M5 2h8v9h-2V4H5zM3 5h7v9H3zm1.5 1.5v6h4v-6z',
  maximise: 'M2 2h5v1.5H3.5V7H2zM14 14H9v-1.5h3.5V9H14z',
  restore: 'M7 7H2V5.5h3.5V2H7zM9 9h5v1.5h-3.5V14H9z',
  close: 'M4.1 3 8 6.9 11.9 3l1.1 1.1L9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z',
  stop: 'M4 4h8v8H4z',
  copy: 'M5 2h8v9h-2V4H5zM3 5h7v9H3zm1.5 1.5v6h4v-6z',
  reload:
    'M8 3a5 5 0 1 0 4.9 6h-1.55A3.5 3.5 0 1 1 8 4.5c.95 0 1.8.38 2.44 1L8.5 7.5H13V3l-1.5 1.44A4.98 4.98 0 0 0 8 3z',
  external: 'M3 3h5v1.5H4.5v7h7V8H13v5H3zm6 0h4v4h-1.5V5.56L7.53 9.53 6.47 8.47l3.97-3.97H9z',
  add: 'M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z',
} as const;

export type IconName = keyof typeof PATHS;

/** A decorative 16 px glyph; the button around it carries the accessible name. */
export const Icon: Component<{ name: IconName }> = (props) => (
  <svg class="wall-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d={PATHS[props.name]} fill="currentColor" />
  </svg>
);
