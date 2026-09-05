import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Hand-maintained, and it was short enough that a script using fetch failed
// lint for using the runtime it targets. These are all Node built-ins.
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  AbortSignal: 'readonly',
  DOMException: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

export default tseslint.config(
  { ignores: [
      // Browser assets, not source. gl.js is the landing page's WebGL module
      // and is linted by nothing here on purpose: it targets a DOM this config
      // does not describe.
      'docs/**','**/dist/**', '**/node_modules/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      // Conventions from CLAUDE.md, enforced rather than remembered.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named exports only.',
        },
        {
          selector: 'NewExpression[callee.name="Error"]',
          message: 'Typed errors only — never a bare Error.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  {
    // Tooling configs must default-export; they are not part of the spine.
    files: ['*.config.ts', '*.config.js', 'scripts/**/*.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
);
