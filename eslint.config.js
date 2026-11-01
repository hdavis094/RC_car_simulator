// @ts-check
import js from '@eslint/js';
import { builtinModules } from 'node:module';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** UI and Electron packages, matched with their subpaths (`react-dom/client`). */
const uiPackages = ['react', 'react-dom', 'electron', 'zustand', '@rcsim/desktop'];

/** Packages that must stay headless: no UI or Electron imports. */
const headlessImports = {
  patterns: [
    {
      group: uiPackages.flatMap((name) => [name, `${name}/*`]),
      message: 'packages/* run headless (AGENTS.md → Layering). UI code lives in apps/desktop.',
    },
  ],
};

/** Node built-ins in both forms (`fs`, `node:fs`, `fs/promises`). */
const nodeBuiltins = builtinModules
  .filter((name) => !name.startsWith('_'))
  .flatMap((name) => [name, `${name}/*`]);

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/out/',
      '**/.rcsim/',
      'test-results/',
      'playwright-report/',
      'packages/hal/',
      'packages/firmware-template/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx,js,mjs}'],
    rules: { 'no-restricted-imports': ['error', headlessImports] },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'The renderer talks to main only through the preload API.',
            },
          ],
          patterns: [
            {
              group: ['electron/*'],
              message: 'The renderer talks to main only through the preload API.',
            },
            { group: ['node:*', ...nodeBuiltins], message: 'The renderer has no Node access.' },
          ],
        },
      ],
    },
  },
);
