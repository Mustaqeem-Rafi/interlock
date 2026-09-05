import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  URL: 'readonly',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },

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
