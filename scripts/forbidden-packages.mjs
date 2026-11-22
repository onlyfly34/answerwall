/**
 * Packages that must never become a dependency, directly or transitively.
 * A trailing `*` matches any suffix. Used by eslint.config.js (imports) and
 * check-dependencies.mjs (manifests and lockfile).
 */
export const FORBIDDEN_PACKAGES = [
  // Providers are reached only by spawning their official CLI or over plain
  // HTTP; vendor SDKs must not be embedded.
  '@anthropic-ai/*',
  '@openai/*',
  'openai',
  '@google/genai',
  '@google/generative-ai',
  '@google/gemini-cli*',
  '@xai-org/*',
  // No native modules in the default build.
  'node-pty',
  'better-sqlite3',
  'sqlite3',
];

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Source of a regular expression matching a forbidden package name or any subpath of it. */
export const FORBIDDEN_PACKAGE_REGEX = `^(?:${FORBIDDEN_PACKAGES.map((name) =>
  escape(name).replace(/\*/g, '[^/]*'),
).join('|')})(?:/|$)`;
