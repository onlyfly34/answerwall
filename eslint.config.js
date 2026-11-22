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

const restrictImports = (...patterns) => ({
  'no-restricted-imports': ['error', { patterns: [forbiddenPackages, ...patterns] }],
});

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
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
      regex: '^(node:|hono|@hono/|\\.\\./(?!brand\\.ts$))',
      message: 'The protocol must stay browser-safe: only zod, ../brand.ts and its own files.',
    }),
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    ...solid,
    languageOptions: { ...solid.languageOptions, globals: globals.browser },
  },
  {
    files: ['packages/web/src/**'],
    rules: restrictImports({
      regex: '^(node:|@answerwall/core(?!/protocol$))',
      message: 'The web app imports only @answerwall/core/protocol from core.',
    }),
  },
  {
    // The wall consumes the app's services only through src/contracts/.
    files: ['packages/web/src/wall/**'],
    rules: restrictImports(
      {
        regex: '^(node:|@answerwall/core(?!/protocol$))',
        message: 'The web app imports only @answerwall/core/protocol from core.',
      },
      {
        regex: '^(\\.\\./)+(app|infra|pages)/',
        message: 'Use the interfaces in src/contracts/ instead.',
      },
    ),
  },
  prettier,
);
