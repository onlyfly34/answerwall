export const PUBLIC_KEY: string;
export const EXTENSION_ID: string;
export const MINIMUM_CHROME_VERSION: string;

export function chromeVersion(version: string): string;

export interface ManifestOptions {
  name: string;
  version: string;
  hosts: string[];
  test?: { host: string; serverPattern: string };
}

export interface Manifest {
  manifest_version: 3;
  name: string;
  description: string;
  version: string;
  version_name: string;
  minimum_chrome_version: string;
  key: string;
  icons: Record<string, string>;
  action: { default_title: string };
  background: { service_worker: string };
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  content_scripts: { matches: string[]; js: string[]; all_frames: boolean; run_at: string }[];
}

export function buildManifest(options: ManifestOptions): Manifest;
