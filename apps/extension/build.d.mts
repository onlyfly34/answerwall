import type { SiteRule } from './src/rules/schema.ts';

export interface BuildOptions {
  /** Default: `dist` next to the script. */
  outDir?: string;
  /** The test build: also frames the stand-in site of the automated tests. */
  test?: boolean;
  logLevel?: 'info' | 'warn' | 'silent';
}

export interface BuildResult {
  outDir: string;
  version: string;
  /** Every file of the build, relative to `outDir`, sorted. */
  files: string[];
}

export function buildExtension(options?: BuildOptions): Promise<BuildResult>;
/** The site rules, by file name without extension. */
export function readRules(): Record<string, SiteRule>;
export function workspaceVersion(): string;
