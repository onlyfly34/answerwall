import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import solid from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { FORBIDDEN_PACKAGE_REGEX } from './scripts/forbidden-packages.mjs';

const forbiddenPackages = {
  regex: FORBIDDEN_PACKAGE_REGEX,
  message: 'This package is a forbidden dependency (docs/DECISIONS.md §2 and §4).',
};

// A unit reaches another unit only through contracts/, never through its files.
const otherUnits = {
  regex: '^(\\.\\./)+(auth|http|logging|providers|routes|runner|settings|storage|tls)/',
  message: 'Import the interface from contracts/ instead of another unit.',
};

// no-restricted-imports sees only static imports; these cover import() and require().
// The selector syntax cannot hold a slash inside a regular expression.
const forbiddenPackageSelector = `Literal[value=/${FORBIDDEN_PACKAGE_REGEX.replaceAll('/', '\\x2F')}/]`;
const forbiddenDynamicImports = [
  `ImportExpression > ${forbiddenPackageSelector}`,
  `CallExpression[callee.name='require'] > ${forbiddenPackageSelector}`,
].map((selector) => ({ selector, message: forbiddenPackages.message }));

// Node's built-in modules, with or without the `node:` prefix.
const nodeBuiltins = `node:|(${builtinModules.join('|')})$`;

const coreOutsideProtocol = {
  regex: `^(${nodeBuiltins}|@answerwall/core(?!/protocol$))`,
  message: 'The web app imports only @answerwall/core/protocol from core.',
};

// The server app uses core as a package, never through its source files.
const coreSources = {
  regex: '(^|/)packages/',
  message: 'Import @answerwall/core instead of reaching into another package.',
};

const restrictImports = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns: [forbiddenPackages, ...patterns] }],
});

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/coverage/',
      '**/node_modules/',
      'e2e/playwright-report/',
      'e2e/test-results/',
      'apps/desktop/release/',
      'apps/desktop/e2e/playwright-report/',
      'apps/desktop/e2e/test-results/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.js',
            'scripts/*.mjs',
            '.github/scripts/*.d.mts',
            'vitest.config.ts',
            'packages/web/vite.config.ts',
            'packages/web/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...restrictImports(),
      'no-restricted-syntax': ['error', ...forbiddenDynamicImports],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Implementations of async interfaces often have nothing to await.
      '@typescript-eslint/require-await': 'off',
    },
  },
  { files: ['**/*.{js,mjs}'], ...tseslint.configs.disableTypeChecked },
  {
    files: [
      'packages/core/src/{auth,http,logging,providers,routes,runner,settings,storage,tls}/**',
    ],
    rules: restrictImports(otherUnits),
  },
  {
    // The protocol entry runs in the browser.
    files: ['packages/core/src/protocol/**', 'packages/core/src/brand.ts'],
    rules: restrictImports({
      regex: `^(${nodeBuiltins}|hono|@hono/|\\.\\./(?!brand\\.ts$))`,
      message: 'The protocol must stay browser-safe: only zod, ../brand.ts and its own files.',
    }),
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ...solid,
    languageOptions: { ...solid.languageOptions, globals: globals.browser },
  },
  { files: ['packages/web/src/**'], rules: restrictImports(coreOutsideProtocol) },
  {
    // The wall consumes the app's services only through src/contracts/.
    files: ['packages/web/src/wall/**'],
    rules: restrictImports(coreOutsideProtocol, {
      regex: '^(\\.\\./)+(app|infra|pages)/',
      message: 'Use the interfaces in src/contracts/ instead.',
    }),
  },
  {
    // The connection page and the pages' preload scripts run in a browser context.
    files: ['apps/desktop/src/connection/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The desktop shell uses core as a package too.
    files: ['apps/desktop/src/**'],
    rules: restrictImports(coreSources),
  },
  { files: ['apps/server/src/**'], rules: restrictImports(coreSources) },
  {
    files: ['apps/server/src/**'],
    ignores: ['**/*.test.ts'],
    rules: restrictImports(coreSources, {
      regex: '^@answerwall/core/testing$',
      message: 'The fakes are for tests only.',
    }),
  },
  prettier,
);
