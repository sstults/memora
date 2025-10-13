import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Ignore build artifacts and external assets
  {
    ignores: [
      'dist/',
      'node_modules/',
      'config/index-templates/**',
      // Limit lint to TS sources/tests; ignore benchmarks, venvs, and dev mjs scripts
      'benchmarks/**',
      'outputs/**',
      '**/.venv*/**',
      'scripts/dev/**/*.mjs'
    ]
  },

  // Base JS recommended rules
  eslint.configs.recommended,

  // TypeScript recommended (no type-checking for speed/CI simplicity)
  ...tseslint.configs.recommended,

  // Project rules and language options
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module'
    },
    rules: {
      // Project policy: allow console for logs; relax some TS strictness to match current codebase.
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      'prefer-const': 'warn'
    }
  },

  // Disable rules that conflict with Prettier
  prettier
);
