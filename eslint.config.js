// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Packages that must stay headless: no UI or Electron imports. */
const headlessImports = {
  paths: ['react', 'react-dom', 'electron', 'zustand'].map((name) => ({
    name,
    message: 'packages/* run headless (AGENTS.md → Layering). UI code lives in apps/desktop.',
  })),
  patterns: [
    { group: ['@rcsim/desktop', '@rcsim/desktop/*'], message: 'packages/* never import the app.' },
  ],
};

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
          patterns: [{ group: ['node:*'], message: 'The renderer has no Node access.' }],
        },
      ],
    },
  },
);
