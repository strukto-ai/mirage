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
    // Generic commands read flags only through FlagView, which is
    // constructed with the command's spec and throws on a name the spec
    // does not declare. Reaching into the bag directly reads a renamed or
    // misspelled flag as false, which no test catches.
    files: ['packages/core/src/commands/builtin/generic/*.ts'],
    ignores: ['packages/core/src/commands/builtin/generic/*.test.ts'],
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
