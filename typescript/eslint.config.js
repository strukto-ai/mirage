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
  prettierConfig,
)
