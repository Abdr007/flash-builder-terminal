import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // `Promise.reject('string')` is the same anti-pattern as `throw 'string'`
      // — non-Error rejections break `instanceof Error` everywhere downstream.
      // (`only-throw-error` would be the ideal complement but needs typed
      // linting which we deliberately keep off for build speed.)
      'prefer-promise-reject-errors': 'error',
      // `(err as Error).message` was the audit's recurring smell — ban the
      // unsafe cast outright. Use `getErrorMessage(err)` from utils/retry.ts
      // (handles non-Error throws via `String(error)` fallback).
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression > Identifier[name='err'] + TSTypeReference > Identifier[name='Error']",
          message: "Don't `(err as Error).message` — use `getErrorMessage(err)` from utils/retry.ts.",
        },
      ],
      'max-lines': 'off',
      'no-constant-condition': 'off',
      'consistent-return': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
