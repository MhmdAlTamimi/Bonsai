import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint rules, chosen to catch the mistakes this codebase actually makes.
 *
 * The point of paying for typescript-eslint's type-aware rules rather than a
 * faster type-blind linter is `no-floating-promises` and `no-misused-promises`.
 * Almost everything here is async -- runs, git, fetch -- and a dropped `await`
 * does not throw, it just quietly does nothing later. That is the same shape as
 * the two worst bugs this project has had: a stop button that returned silently
 * and a commit step that ran when it should not have.
 *
 * Style is Prettier's job, not the linter's. Nothing here reformats.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // Emitted or vendored; not ours to lint.
      'packages/ui/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // One project service rather than a list of tsconfigs: the packages are
        // project references, and the service resolves them the way tsc does.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The rules this whole toolchain is here for. An unhandled promise is
       * invisible at runtime and expensive here, where the thing not happening
       * is usually a run that is still costing money.
       */
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test's describe/test return promises the runner owns. Without
          // this every test in the suite is a false positive, and 108 false
          // positives is how a linter gets switched off.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',

      // The compiler is set to noPropertyAccessFromIndexSignature, which makes
      // process.env['X'] mandatory -- so the rule that objects to it is
      // arguing with tsconfig, not with the code.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],

      // T[] for simple types, Array<T> for anything with structure. That is
      // already how the code reads: `readonly NodeStatus[]` next to
      // `Array<{ id: string; name: string }>`.
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],

      // `catch {}` is used deliberately in a dozen places -- a broken symlink
      // in the picker, an unreadable settings file -- and each one is
      // commented. Empty blocks elsewhere are still worth flagging.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // The codebase leans on `!` where an invariant has just been established
      // (a row that was inserted a line earlier). Flagging every one would be
      // noise without type narrowing that TypeScript cannot do here.
      '@typescript-eslint/no-non-null-assertion': 'off',

      // `_`-prefixed parameters are the established convention for the
      // arguments a route handler is handed but does not want.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // An `onClick={() => void save()}` is the codebase's idiom for firing an
      // async handler, and it is correct: the promise is deliberately not
      // awaited by the event system. The rule cannot tell that apart from a
      // genuine mistake in JSX attributes, so it checks everything else.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  {
    // Tests assert against `any`-shaped rows and temp paths often enough that
    // the strictest rules cost more than they catch here.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  {
    // Plain Node scripts, outside any package's tsconfig. Type-aware rules
    // cannot run without a project, so they are switched off rather than left
    // to fail on every line with a parse error.
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: tseslint.configs.disableTypeChecked.rules,
  },
);
