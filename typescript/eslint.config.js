import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

// JavaScript's default comparator orders by UTF-16 code unit, so an astral
// filename (U+10000 and up, stored as a surrogate pair in 0xD800-0xDFFF)
// sorts before every BMP name from U+E000 up, while Python's `sorted` puts
// it after -- issue #370. It is also wrong for numbers and tuples, which it
// compares as strings. Pass an explicit comparator: `compareCodePoints` for
// anything a user sees the order of. Tests are exempt, as they are for the
// flag rule below: a test sorts its own expectation, so it stays
// self-consistent either way.
const SORT_COMPARATOR_SELECTOR = {
  selector: "CallExpression[callee.property.name='sort'][arguments.length=0]",
  message:
    'Pass a comparator to .sort(); the default orders by UTF-16 code unit and diverges from Python on astral characters (#370). Use compareCodePoints for strings.',
}

const FLAG_BAG_MESSAGE =
  'Read flags through FlagView (new FlagView(opts.flags, specOf(name))), not the flag bag directly.'

// Commands read flags only through FlagView, which is constructed with the
// command's spec and throws on a name the spec does not declare. Reaching
// into the bag directly reads a renamed or misspelled flag as false, which
// no test catches. Python's twin is
// `tests/commands/test_no_raw_flag_reads.py`, which walks the whole
// `mirage/commands` tree and bans `flags.get(...)` / `flags[...]` under the
// three names the bag arrives as; these selectors cover the same ground for
// the shapes TypeScript writes it in.
const FLAG_BAG_SELECTORS = [
  {
    // opts.flags.x, opts.flags['x'], inv.flags.x -- the bag reached through
    // the two records that carry it.
    selector:
      "MemberExpression[object.type='MemberExpression'][object.object.name=/^(opts|inv)$/][object.property.name='flags']",
    message: FLAG_BAG_MESSAGE,
  },
  {
    // `const flags = opts.flags`. Aliasing the bag into a local is how
    // every read below the alias escaped the old selector; banning the
    // alias itself is what makes `flags.c` unwritable without naming a
    // second shape. Passing `opts.flags` to FlagView or to a helper that
    // takes the whole bag stays legal.
    selector:
      "VariableDeclarator[init.type='MemberExpression'][init.object.name=/^(opts|inv)$/][init.property.name='flags']",
    message: FLAG_BAG_MESSAGE,
  },
  {
    // flags['x'] / flags[name] / kwargs[name]. Reads only: a wrapper still
    // builds an overridden bag to hand down (crossmount fanout does), which
    // is the same exemption Python's regex makes with its `(?!\s*=[^=])`
    // lookahead. A parsed flag struct is never subscripted, so no struct
    // read is caught here.
    selector:
      'MemberExpression[computed=true][object.name=/^(flags|flagKwargs|kwargs)$/]:not(AssignmentExpression > MemberExpression.left)',
    message: FLAG_BAG_MESSAGE,
  },
  {
    // flags.show_all / flags.args_I. A spec dest is spelled the way Python
    // spells it (snake_case, `args_*`), while a parsed flag struct's field
    // is camelCase, so an underscore in the property is what tells a bag
    // read from a struct read when both are named `flags`.
    selector:
      'MemberExpression[computed=false][object.name=/^(flags|flagKwargs|kwargs)$/][property.name=/_/]:not(AssignmentExpression > MemberExpression.left)',
    message: FLAG_BAG_MESSAGE,
  },
]

// The spec layer builds the flag mapping, so it reads and writes it
// directly, and the @command wrapper answers --help/--version off the bag
// before the command it wraps ever sees it. One entry per member of
// Python's `EXEMPT` set in tests/commands/test_no_raw_flag_reads.py.
const FLAG_BAG_EXEMPT = [
  'packages/*/src/commands/spec/parser.ts',
  'packages/*/src/commands/spec/shell.ts',
  'packages/*/src/commands/spec/types.ts',
  'packages/*/src/commands/cli/walk.ts',
  'packages/*/src/commands/config.ts',
]

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/*.config.ts',
      '**/*.config.js',
      '**/*.setup.ts',
      // Narrowed from '**/scripts/**': `packages/*/scripts/*.mjs` are
      // build helpers, but `typescript/scripts/*.ts` generates `spec/`,
      // which pre-commit's Spec drift step and `check_spec_parity.py` both
      // read, so it is production code and is linted (issue #1089 item
      // 20b).
      'packages/*/scripts/**',
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
    ...tseslint.configs.disableTypeChecked,
    files: ['packages/core/src/runtime/js/quickjs/js/*.js'],
    languageOptions: {
      globals: {
        std: 'readonly',
        os: 'readonly',
        __mirage_log: 'readonly',
        __mirage_error: 'readonly',
        __mirage_stdin: 'readonly',
        __mirage_setExit: 'readonly',
        __mirage_env: 'readonly',
        __mirage_open: 'readonly',
        __mirage_read: 'readonly',
        __mirage_getline: 'readonly',
        __mirage_write: 'readonly',
        __mirage_seek: 'readonly',
        __mirage_tell: 'readonly',
        __mirage_eof: 'readonly',
        __mirage_close: 'readonly',
        __mirage_readdir: 'readonly',
        __mirage_stat: 'readonly',
        __mirage_remove: 'readonly',
        __mirage_mkdir: 'readonly',
        __mirage_rename: 'readonly',
        __mirage_utimes: 'readonly',
      },
      parserOptions: { projectService: false },
    },
  },
  {
    // `typescript/scripts/*.ts` is production code: pre-commit runs
    // `gen-specs.ts` and then `git diff --exit-code spec/`, and
    // `check_spec_parity.py` reads what it emits. It was excluded from
    // eslint by a blanket `**/scripts/**` ignore, which is why eight bare
    // `.sort()` calls feeding `spec/**` survived the repo's own #370 rule
    // (issue #1089 item 20b).
    //
    // The type-aware preset is off here, not on: these files have no
    // package tsconfig above them, so the project service finds no program
    // and every file parse-errors instead of linting. The syntactic rules
    // -- the sort gate above all, plus no-unused-vars and no-empty -- are
    // what this directory needed and they need no types. Giving it its own
    // tsconfig and turning the type-aware layer back on is a follow-up:
    // it reports ~120 findings, most of them in `gen-specs.ts`, and
    // `pnpm -r typecheck` excludes the workspace root, so wiring tsc for
    // it also needs a CI step rather than a root script.
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/**/*.ts'],
    languageOptions: { parserOptions: { projectService: false } },
  },
  {
    files: ['packages/*/src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['packages/*/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', SORT_COMPARATOR_SELECTOR],
    },
  },
  {
    files: ['packages/*/src/commands/**/*.ts'],
    ignores: ['packages/*/src/commands/**/*.test.ts', ...FLAG_BAG_EXEMPT],
    rules: {
      'no-restricted-syntax': ['error', SORT_COMPARATOR_SELECTOR, ...FLAG_BAG_SELECTORS],
    },
  },
  {
    // CLAUDE.md: code in `core` must work in both the browser and the Node
    // runtimes. The Node half is already gated -- `tsconfig.build.json`
    // sets `types: []`, so a `node:*` import or a bare `process`/`Buffer`
    // fails the build. The browser half was gated by nothing: `document`,
    // `window` and friends come from `lib.dom`, which core needs for
    // `fetch`/`Response`/`Headers`/`CompressionStream`, so they typecheck,
    // test and build clean and only fail at runtime inside a Node consumer
    // of the package. Violation count when this landed was zero, so it is a
    // pure ratchet (issue #1089 item 10).
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'document',
          'window',
          'localStorage',
          'sessionStorage',
          'navigator',
          'indexedDB',
          'alert',
          'FileSystemDirectoryHandle',
        ].map((name) => ({
          name,
          message: `${name} is browser-only; core runs in Node too. Put it in @struktoai/mirage-browser.`,
        })),
      ],
    },
  },
  prettierConfig,
)
