import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.config.ts',
      '**/*.config.js',
      '**/*.setup.ts',
      '**/scripts/**',
      '**/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Commands read flags only through FlagView, which is constructed
    // with the command's spec and throws on a name the spec does not
    // declare. Reaching into the bag directly reads a renamed or
    // misspelled flag as false, which no test catches. Python's twin is
    // `tests/commands/test_no_raw_flag_reads.py`, which walks the whole
    // `mirage/commands` tree, so this covers the same ground.
    files: ['packages/*/src/commands/builtin/**/*.ts'],
    ignores: ['packages/*/src/commands/builtin/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='opts'][object.property.name='flags']",
          message:
            'Read flags through FlagView (new FlagView(opts.flags, specOf(name))), not opts.flags directly.',
        },
      ],
    },
  },
  {
    // JavaScript's default comparator orders by UTF-16 code unit, so an
    // astral filename (U+10000 and up, stored as a surrogate pair in
    // 0xD800-0xDFFF) sorts before every BMP name from U+E000 up, while
    // Python's `sorted` puts it after -- issue #370. It is also wrong for
    // numbers and tuples, which it compares as strings. Pass an explicit
    // comparator: `compareCodePoints` for anything a user sees the order
    // of. Tests are exempt, as they are for the flag rule above: a test
    // sorts its own expectation, so it stays self-consistent either way.
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='sort'][arguments.length=0]",
          message:
            'Pass a comparator to .sort(); the default orders by UTF-16 code unit and diverges from Python on astral characters (#370). Use compareCodePoints for strings.',
        },
      ],
    },
  },
  prettierConfig,
)
