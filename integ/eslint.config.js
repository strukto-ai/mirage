import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

// integ is its own base path, so this config lives here rather than in
// typescript/: ESLint 9 ignores any file outside the directory holding the
// config that selected it, which is why `eslint ../integ` from typescript/
// answered "File ignored because outside of base path" and integ was silently
// unlinted. The rule set is the untyped one on purpose -- typescript/'s
// strictTypeChecked presets are calibrated for the published packages, and the
// runners and the older fakes here would answer with hundreds of findings that
// have nothing to do with the fakes this tree exists to serve.
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/generated/**', 'truth/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The CLI fixtures are plain JavaScript loaded by the tally-CLI cases, so
    // no-undef is live for them where it is off for every TypeScript file.
    // TextEncoder is a node builtin; naming the two of them is cheaper than
    // pulling in the `globals` package for one identifier.
    files: ['fixtures/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { TextEncoder: 'readonly', TextDecoder: 'readonly' } },
  },
  {
    // The adapters package is loaded once per battery run whatever the target
    // is, and a kit fake's module reaches its generated Prisma client at
    // import time. A static import here therefore makes `--target nextcloud`
    // die with ERR_MODULE_NOT_FOUND on a job that has no reason to generate
    // that client, which is invisible locally because a developer tree always
    // has one. Load an in-process fake with `await import(...)` inside its
    // opener.
    files: ['runners/typescript/adapters/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: String.raw`ImportDeclaration[source.value=/^(\.\.\/)+server\/.*\/fake\.ts$/]`,
          message:
            "Import a kit fake lazily (await import(...)) inside its opener; a static import here forces every target to have that fake's generated Prisma client.",
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // varsIgnorePattern as well as argsIgnorePattern: the runners omit a key
      // by destructuring it into a leading-underscore name and spreading the
      // rest, which is a variable and not an argument.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettierConfig,
)
