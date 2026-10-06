// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { GNU_LONG_OPTIONS } from './long_options.ts'
import { Option } from './types.ts'

// The two options every registered command answers, as GNU coreutils does.
// They live here rather than beside the wrapper that injects them because
// they are grammar: `commands/config.ts` appends them to a spec before the
// parser reads the line, and a CLI node appends --help the same way. Shared
// SINGLETONS, so `o === HELP_OPTION` identifies one through any copy of a
// spec, which is what tells a builtin's grammar apart from a registered
// command that borrowed its name.
export const HELP_OPTION = new Option({
  long: '--help',
  type: 'bool',
  description: 'Show this help and exit',
})

export const VERSION_OPTION = new Option({
  long: '--version',
  type: 'bool',
  description: 'Show version information and exit',
})

// Stand-in name for a required operand whose slot declares none, so a
// refusal that has to name the slot always has a word for it. Bare like
// every operand name: the brackets are the renderer's.
export const ARG_PLACEHOLDER = 'ARG'

// The path options whose lone `-` is stdout rather than a file, keyed by
// command, valued by the option's canonical spelling: `wget -O -` and
// `curl -D -`. Such a value stays `-`, unresolved and outside routing.
// Explicit `./-` still names a file (curl 8.14.1 writes `-D ./-` there).
export const STDOUT_DASH_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['wget', '-O'],
  ['curl', '--dump-header'],
])

// CPython and node read the script from stdin for a lone `-`, including
// after `--`. Explicit `./-` still names a file (CPython 3.12, node 22).
export const STDIN_SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'js',
  'node',
])

// The commands that read standard input for a lone `-` operand, so the word
// names no path and routes nowhere: `split - /data/x` runs on /data from any
// working directory. Everywhere else (`touch -`, `rev -`) it is a file in the
// working directory, and explicit `./-` always is.
export const STDIN_DASH_COMMANDS: ReadonlySet<string> = new Set([
  'awk',
  'base64',
  'cat',
  'cmp',
  'comm',
  'csplit',
  'cut',
  'diff',
  'expand',
  'fmt',
  'fold',
  'grep',
  'gunzip',
  'gzip',
  'head',
  'join',
  'md5sum',
  'nl',
  'od',
  'paste',
  'rg',
  'sed',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'sort',
  'split',
  'tac',
  'tail',
  'unexpand',
  'uniq',
  'wc',
  'xxd',
  'zcat',
])

// How many leading operands may read standard input, for a command whose
// later operands name outputs: split reads FILE and writes PREFIX, so
// `split f -` writes `-aa` to the working directory (GNU coreutils 9.7).
export const STDIN_DASH_LEADING: ReadonlyMap<string, number> = new Map([['split', 1]])

// The name an operand goes by on a flag bag's tape. The tape records the
// operands in scan order among the option occurrences, so a program can tell
// which options were typed before each one. An operand has no dest, and no
// option's dest is empty.
export const OPERAND = ''

// The programs whose option loop files each operand the moment it reads it,
// so the rest slot's textWhen options turn textual only the operands typed
// after the first of them, and the operands before it keep the declared kind.
// jq's main.c walks argv once: a word before any --args or --jsonargs is an
// input file, and one after either is a positional value (jq 1.8.2 reads
// `jq -c '[., $ARGS.positional]' f.json --args a` as f.json plus ["a"]). tar
// reads the whole line first: GNU tar 1.35 lists `d/m` for
// `tar -f a.tar d/m -t` as it does for `tar -f a.tar -t d/m`. Measured, not
// derived, like the other per-program rules. join's getopt loop runs
// RETURN_IN_ORDER too, so `join a b c -a 3` refuses the extra operand before
// the bad file number, and a missing-operand line names the line's last word
// rather than its last operand: `join a.txt -t ,` is missing an operand after
// ',' (coreutils 9.7). Info-ZIP's unzip reads its words in order too: -x takes
// every operand after it, up to a -d (UnZip 6.00).
export const IN_ORDER_OPERANDS: ReadonlySet<string> = new Set(['jq', 'join', 'unzip'])

// The option words an IN_ORDER_OPERANDS program's own loop reads by their
// spelling, so the tape keeps each one where it was typed, as [SPELLED, word]
// just before the occurrence it spells. join.c takes a lone `-j1` or `-j2`
// (`optarg == argv[optind - 1] + 2`) as the obsolete `-j1 FIELD` until no
// operand is left for FIELD, while `-j 1` and `-ij1` are always both files'
// field 1, and it reads every operand after `--` as a file (coreutils 9.7).
export const SPELLED_WORDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  join: new Set(['-j1', '-j2', '--']),
})

// The programs whose option loop reads a dash-led word as options only when a
// letter follows the dash, and any other one as an operand where it sits:
// jq's isoptish() is a dash followed by a second dash or isalpha(). Measured
// on jq 1.8.2: `jq -n '-1'` runs the program -1, `jq . -1` reads a file named
// -1, `--jsonargs -1 -.5` reads [-1,-0.5] and `--args - -. '- x'` reads three
// strings, while `-x` is still refused and `-nan` is -n, -a and -n. The letter
// is an ASCII one: `-é` is an operand in the POSIX and the C.UTF-8 locale
// alike.
export const LETTER_OPTIONS: ReadonlySet<string> = new Set(['jq'])

// The dash-led words such a program reads as options. A `--` word takes the
// long-option branch before this is asked.
export const DASH_LETTER = /^-[A-Za-z]/

// The programs that read a dash followed by a digit or a point as a negative
// number before each getopt call, and stop scanning options there: the word
// and every word after it are operands. Measured on coreutils 9.7: `seq -1.5
// 1` counts from -1.5, `seq -.5 .5` from -0.5, and `seq -1 -w 1` refuses -w
// as LAST, while `seq -inf` is still the invalid option -i.
export const NEGATIVE_NUMBER_OPERANDS: ReadonlySet<string> = new Set(['seq'])

// The dash-led words such a program takes for a negative number.
export const NEGATIVE_NUMBER = /^-[.0-9]/

// The programs that compare a long option's whole word against their own
// table, as strcmp does, `=` included, so `--name=value` is an unknown option,
// value and all, rather than the option and its value. Measured on jq 1.8.2:
// `--indent=3` and `--slurp=1` are each refused as `jq: Unknown option` with
// the word as typed. jq takes no abbreviation either, which is argparse's
// allowAbbrev, so its spec declares that instead.
export const WHOLE_WORD_LONG_OPTIONS: ReadonlySet<string> = new Set(['jq'])

// The programs whose handler runs the option loop: the parser leaves each
// option it refuses on the tape where it met it, as [REFUSED, word], and
// nothing ahead of the handler refuses the line or answers --help for it.
// jq's main.c walks argv once and stops at the first word it cannot take, so
// a bad --jsonargs value, --indent width or --slurpfile typed first is the
// one reported, and --help and --version answer where they stand. Measured
// on jq 1.8.2: `jq -n . --jsonargs '{' --bogus` reports the JSON,
// `jq -n . --bogus --jsonargs '{'` reports --bogus, and `jq --help --bogus`
// prints the help.
export const OWN_OPTION_LOOP: ReadonlySet<string> = new Set(['jq'])

// The name a refused option goes by on the tape of an OWN_OPTION_LOOP
// program, whose value is the option word as the program names it: the whole
// word for a long option (`--indent=3`), the dash and the first letter it
// does not know for a cluster (`-x`), and the option itself when the line
// ends before its value (`--arg`). No option of such a program is spelled
// `-?`, so no dest is `?`.
export const REFUSED = '?'

// The name a SPELLED_WORDS word goes by on the tape. No option is spelled
// `-=`, so no dest is `=`.
export const SPELLED = '='

const AMBIGUOUS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  l: 'args_l',
  O: 'args_O',
  I: 'args_I',
  '1': 'args_1',
})

// Numeric shorthand token like `-5` (head/tail count), never a flag
// cluster or a path.
/**
 * Map a flag name to its dispatcher kwarg name.
 *
 * Mirrors Python's `flag_kwarg_name`. The dispatcher spells flags without
 * their dashes and with dashes turned into underscores, so this is the one
 * place that translation lives.
 */
export function flagKwargName(flag: string): string {
  const clean = flag.replace(/^-+/, '').replaceAll('-', '_')
  return AMBIGUOUS_NAMES[clean] ?? clean
}

export const NUMERIC_SHORT = /^-\d+$/

// GNU echo is not getopt, so its option surface is a word shape, not a
// CommandSpec: options are LEADING words matching this pattern only.
export const ECHO_OPTION = /^-[neE]+$/

// The programs with NO long-option parser at all: their answer to a
// dash-leading word they do not recognize is to print it as an operand rather
// than to refuse it, and they never expand an abbreviation. bash's `echo`
// builtin reads only a leading `-neE` cluster and prints every other word
// verbatim, `--` included (`echo -- --zzz` prints `-- --zzz`); Info-ZIP unzip
// has no `--long` grammar either, scanning the word's letters instead, so
// `unzip --nothelp` prints help for the `h` the word happens to contain.
// unzip's own refusal -- exit 10 with the whole usage block, and `--` not an
// end-of-options marker -- is a separate change; it sits here because of the
// two answers the parser has today, the lenient one is the closer.
//
// MEASURED against coreutils 9.4, bash 5.2.21 and Info-ZIP 6.00, and
// deliberately NOT derived. #1107 proposed deriving it -- require that "the
// command declare no long options" -- and no predicate over the declarations
// can work: `sleep`, `pwd`, `bc`, `history` and `printf` declare zero long
// options in mirage's specs and all five REPORT an option they do not know,
// while `echo` declares zero and treats it as an operand, so `expr` and
// `sleep` are indistinguishable that way. The `@command` decorator also
// injects `--help`/`--version` into every registered spec, so no spec declares
// zero by the time the parser reads it. Ten of the thirteen commands the old
// rest-operand-kind predicate reached (basename, dirname, csplit, numfmt,
// sleep, pwd, bc, history, bash, printf) are strict, which is why this is an
// exception list and not a rule.
export const NO_LONG_OPTIONS: ReadonlySet<string> = new Set(['echo', 'unzip'])

// The programs whose long options are parsed ONLY when the line carries
// exactly one argument: gnulib's `parse_long_options`, whose guard is
// literally `argc == 2`. Measured on coreutils 9.4: `expr --help` exits 0 with
// help, `expr --help x` exits 2 with
// `expr: syntax error: unexpected argument 'x'`, and `expr -- --help` is argc
// 3, so it prints `--help`. Inside the window getopt_long's name-prefix
// matching applies (`--h`, `--hel` and `--versio` all resolve) and a word that
// prefixes nothing falls through to an operand with no diagnostic at all,
// because parse_long_options sets `opterr = 0`: `expr --hex` prints `--hex`,
// and so does `expr --help=x`. This is a narrower rule than NO_LONG_OPTIONS
// and not the same one -- echo has no long options in any position, expr has
// them in exactly one -- so the two are spelled separately rather than
// collapsed.
export const SOLE_ARGUMENT_LONG_OPTIONS: ReadonlySet<string> = new Set(['expr'])

// The two programs that answer a standard option only once the WHOLE option
// scan has succeeded, rather than at the position the word sits in. GNU grep's
// getopt loop sets `show_version` / `show_help` and keeps scanning, printing
// after the loop, so a refusal anywhere on the line outranks the answer;
// ripgrep's clap parse is whole-line for the same reason. Measured on GNU grep
// 3.11 and ripgrep 14.1.1, and for BOTH options: `grep --version --bogus`,
// `grep --help --bogus` and `rg --version --bogus` all report the option and
// exit 2, where `cat --version --bogus` prints the version and
// `cat --help --bogus` the help page, both exit 0, because coreutils calls
// `version_etc` or `usage` and exits INSIDE the loop.
export const STANDARD_AFTER_SCAN: ReadonlySet<string> = new Set(['grep', 'rg'])

// The programs whose getopt string lists the ten digits as options, the
// obsolete `-NUM` count spelled one letter at a time: the digits of one word
// build a number and a later word replaces it, wherever they sit in a
// cluster. Measured on coreutils 9.7: `split -d10` is `-d` and ten lines, as
// are `-10d` and `-dx10`, and `split -12 -5` is five. head and tail list the
// digits too but refuse one past the first word, so they keep only the
// whole-word `-NUM` that numericShorthand reads.
export const DIGIT_OPTIONS: ReadonlySet<string> = new Set(['split'])

// The long spellings that are one option under two names, keyed by
// "<program> <synonym>" to the spelling it duplicates: glibc's several
// long_options entries sharing one `val`, so a prefix of both resolves rather
// than being ambiguous. Every other pair of declared longs is two options,
// and a prefix of both is ambiguous, which is what getopt_long answers for
// `ls --re` and `uname --k`. Measured on coreutils 9.7 and grep 3.11:
// `grep --col` is --color and `date --u` is --utc. Python keys the same table
// by (program, synonym) pairs.
export const LONG_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['grep --colour', '--color'],
  ['date --universal', '--utc'],
  ['rg --passthrough', '--passthru'],
])

// The whole long-option table of a program whose getopt_long resolves an
// abbreviation against more options than mirage declares for it, so a partial
// spec cannot say whether a prefix is ambiguous: `tar --fil` is `--file` or
// `--files-from`, the second one mirage never declared. Each group is one
// option, its primary spelling first and its aliases after it (argp's
// OPTION_ALIAS entries, which share the primary's key and so never make a
// prefix of both ambiguous), in the order getopt_long reads the table, which
// is the order it lists possibilities in. A prefix names an option this table
// resolves; one mirage does not declare stays unrecognized.
//
// GNU tar 1.35: argp hands getopt_long tar.c's options, then names.c's, then
// argp's own --help, --usage, --program-name and --HANG, then --version.
// Mirrors Python's TAR_LONG_OPTIONS.
export const TAR_LONG_OPTIONS: readonly (readonly string[])[] = [
  ['--list'],
  ['--extract', '--get'],
  ['--create'],
  ['--diff', '--compare'],
  ['--append'],
  ['--update'],
  ['--catenate', '--concatenate'],
  ['--delete'],
  ['--test-label'],
  ['--sparse'],
  ['--hole-detection'],
  ['--sparse-version'],
  ['--incremental'],
  ['--listed-incremental'],
  ['--level'],
  ['--ignore-failed-read'],
  ['--occurrence'],
  ['--seek'],
  ['--no-seek'],
  ['--no-check-device'],
  ['--check-device'],
  ['--verify'],
  ['--remove-files'],
  ['--keep-old-files'],
  ['--skip-old-files'],
  ['--keep-newer-files'],
  ['--overwrite'],
  ['--unlink-first'],
  ['--recursive-unlink'],
  ['--no-overwrite-dir'],
  ['--overwrite-dir'],
  ['--keep-directory-symlink'],
  ['--one-top-level'],
  ['--to-stdout'],
  ['--to-command'],
  ['--ignore-command-error'],
  ['--no-ignore-command-error'],
  ['--owner'],
  ['--group'],
  ['--owner-map'],
  ['--group-map'],
  ['--mtime'],
  ['--clamp-mtime'],
  ['--mode'],
  ['--atime-preserve'],
  ['--touch'],
  ['--same-owner'],
  ['--no-same-owner'],
  ['--numeric-owner'],
  ['--preserve-permissions', '--same-permissions'],
  ['--no-same-permissions'],
  ['--preserve-order', '--same-order'],
  ['--delay-directory-restore'],
  ['--no-delay-directory-restore'],
  ['--sort'],
  ['--xattrs'],
  ['--no-xattrs'],
  ['--xattrs-include'],
  ['--xattrs-exclude'],
  ['--selinux'],
  ['--no-selinux'],
  ['--acls'],
  ['--no-acls'],
  ['--file'],
  ['--force-local'],
  ['--rmt-command'],
  ['--rsh-command'],
  ['--multi-volume'],
  ['--tape-length'],
  ['--info-script', '--new-volume-script'],
  ['--volno-file'],
  ['--blocking-factor'],
  ['--record-size'],
  ['--ignore-zeros'],
  ['--read-full-records'],
  ['--format'],
  ['--old-archive', '--portability'],
  ['--posix'],
  ['--pax-option'],
  ['--label'],
  ['--auto-compress'],
  ['--no-auto-compress'],
  ['--use-compress-program'],
  ['--bzip2'],
  ['--gzip', '--gunzip', '--ungzip'],
  ['--compress', '--uncompress'],
  ['--lzip'],
  ['--lzma'],
  ['--lzop'],
  ['--xz'],
  ['--zstd'],
  ['--one-file-system'],
  ['--absolute-names'],
  ['--dereference'],
  ['--hard-dereference'],
  ['--starting-file'],
  ['--newer', '--after-date'],
  ['--newer-mtime'],
  ['--backup'],
  ['--suffix'],
  ['--strip-components'],
  ['--transform', '--xform'],
  ['--checkpoint'],
  ['--checkpoint-action'],
  ['--check-links'],
  ['--totals'],
  ['--utc'],
  ['--full-time'],
  ['--index-file'],
  ['--block-number'],
  ['--show-defaults'],
  ['--show-snapshot-field-ranges'],
  ['--show-omitted-dirs'],
  ['--show-transformed-names', '--show-stored-names'],
  ['--quoting-style'],
  ['--quote-chars'],
  ['--no-quote-chars'],
  ['--interactive', '--confirmation'],
  ['--verbose'],
  ['--warning'],
  ['--restrict'],
  ['--add-file'],
  ['--directory'],
  ['--files-from'],
  ['--null'],
  ['--no-null'],
  ['--unquote'],
  ['--no-unquote'],
  ['--verbatim-files-from'],
  ['--no-verbatim-files-from'],
  ['--exclude'],
  ['--exclude-from'],
  ['--exclude-caches'],
  ['--exclude-caches-under'],
  ['--exclude-caches-all'],
  ['--exclude-tag'],
  ['--exclude-ignore'],
  ['--exclude-ignore-recursive'],
  ['--exclude-tag-under'],
  ['--exclude-tag-all'],
  ['--exclude-vcs'],
  ['--exclude-vcs-ignores'],
  ['--exclude-backups'],
  ['--recursion'],
  ['--no-recursion'],
  ['--anchored'],
  ['--no-anchored'],
  ['--ignore-case'],
  ['--no-ignore-case'],
  ['--wildcards'],
  ['--no-wildcards'],
  ['--wildcards-match-slash'],
  ['--no-wildcards-match-slash'],
  ['--help'],
  ['--usage'],
  ['--program-name'],
  ['--HANG'],
  ['--version'],
]
export const LONG_OPTION_TABLES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  ...GNU_LONG_OPTIONS,
  tar: TAR_LONG_OPTIONS,
}

// The programs whose short value options drop one `=` from an attached value,
// the way lexopt (ripgrep's parser), clap and argparse read `-x=VALUE`. GNU
// getopt keeps it (`head -n=5` is refused as `=5`), which is every other
// builtin. Measured on ripgrep 14.1.1: `rg -g=*.py`, `rg -m=1`, `rg -A=1` and
// `rg -e=hello` read `*.py`, `1`, `1` and `hello`.
export const EQUALS_SHORT_VALUES: ReadonlySet<string> = new Set(['rg'])

// ripgrep's own flag table, every long name, negation and alias in the order
// of its FLAGS array (crates/core/flags/defs.rs, 14.1.1). ripgrep takes no
// abbreviation of any of them (`rg --pcr` is `unrecognized flag --pcr`) and
// suggests the ones whose name shares at least 40% of its 3-grams with an
// unknown flag, in this order (flags/parse.rs, `suggest`).
export const RG_FLAG_NAMES: readonly string[] = [
  'regexp',
  'file',
  'after-context',
  'before-context',
  'binary',
  'no-binary',
  'block-buffered',
  'no-block-buffered',
  'byte-offset',
  'no-byte-offset',
  'case-sensitive',
  'color',
  'colors',
  'column',
  'no-column',
  'context',
  'context-separator',
  'no-context-separator',
  'count',
  'count-matches',
  'crlf',
  'no-crlf',
  'debug',
  'dfa-size-limit',
  'encoding',
  'no-encoding',
  'engine',
  'field-context-separator',
  'field-match-separator',
  'files',
  'files-with-matches',
  'files-without-match',
  'fixed-strings',
  'no-fixed-strings',
  'follow',
  'no-follow',
  'generate',
  'glob',
  'glob-case-insensitive',
  'no-glob-case-insensitive',
  'heading',
  'no-heading',
  'help',
  'hidden',
  'no-hidden',
  'hostname-bin',
  'hyperlink-format',
  'iglob',
  'ignore-case',
  'ignore-file',
  'ignore-file-case-insensitive',
  'no-ignore-file-case-insensitive',
  'include-zero',
  'no-include-zero',
  'invert-match',
  'no-invert-match',
  'json',
  'no-json',
  'line-buffered',
  'no-line-buffered',
  'line-number',
  'no-line-number',
  'line-regexp',
  'max-columns',
  'max-columns-preview',
  'no-max-columns-preview',
  'max-count',
  'max-depth',
  'maxdepth',
  'max-filesize',
  'mmap',
  'no-mmap',
  'multiline',
  'no-multiline',
  'multiline-dotall',
  'no-multiline-dotall',
  'no-config',
  'no-ignore',
  'ignore',
  'no-ignore-dot',
  'ignore-dot',
  'no-ignore-exclude',
  'ignore-exclude',
  'no-ignore-files',
  'ignore-files',
  'no-ignore-global',
  'ignore-global',
  'no-ignore-messages',
  'ignore-messages',
  'no-ignore-parent',
  'ignore-parent',
  'no-ignore-vcs',
  'ignore-vcs',
  'no-messages',
  'messages',
  'no-require-git',
  'require-git',
  'no-unicode',
  'unicode',
  'null',
  'null-data',
  'one-file-system',
  'no-one-file-system',
  'only-matching',
  'path-separator',
  'passthru',
  'passthrough',
  'pcre2',
  'no-pcre2',
  'pcre2-version',
  'pre',
  'no-pre',
  'pre-glob',
  'pretty',
  'quiet',
  'regex-size-limit',
  'replace',
  'search-zip',
  'no-search-zip',
  'smart-case',
  'sort',
  'sortr',
  'stats',
  'no-stats',
  'stop-on-nonmatch',
  'text',
  'no-text',
  'threads',
  'trace',
  'trim',
  'no-trim',
  'type',
  'type-not',
  'type-add',
  'type-clear',
  'type-list',
  'unrestricted',
  'version',
  'vimgrep',
  'with-filename',
  'no-filename',
  'word-regexp',
  'auto-hybrid-regex',
  'no-auto-hybrid-regex',
  'no-pcre2-unicode',
  'pcre2-unicode',
  'sort-files',
  'no-sort-files',
]

// The one program whose standard options outrank every option refusal,
// wherever the word sits. zgrep is a shell script that reads the line in its
// own loop before it ever builds a grep command, and that loop answers both
// itself. Measured on gzip 1.13: `zgrep --bogus --version f.gz` and
// `zgrep --bogus --help f.gz` each print zgrep's own output and exit 0, while
// `zgrep --bogus f.gz` reaches grep and is refused with exit 2.
export const STANDARD_BEFORE_SCAN: ReadonlySet<string> = new Set(['zgrep'])

// The spec-declared `choices` sets that ARE gnulib ARGMATCH tables, so an
// unambiguous prefix of a candidate resolves to it and the bag is rewritten
// to the canonical word. Every other declared set compares the whole word,
// which is argparse's own rule for `choices` and so the right default for
// the grammar this spec layer is modelled on: a mount author's custom
// `--mode` with choices ('read', 'remove') refuses `rem`, and an installed
// CLI's node refuses `--state=o`, as clap and git do.
//
// It is an opt-in table because prefix matching is the rare case, not the
// common one: the GNU commands that really do own an argmatch table --
// `--backup`, `ls --sort`, `ls --time`, `sort --check`, `cp --update`,
// `tail --follow`, `wc --total`, `uniq`, `cut` -- call `argmatch` from the
// command with their own candidate list, and never reach the parser's
// `Option.choices` at all. The entries below are the whole of what does.
// Measured on coreutils 9.7: `tee --output-error=exit-n` resolves to
// `exit-nopipe` while `=w` and `=e` are ambiguous, `numfmt --to=s` resolves
// to `si` and `--to=ie` is ambiguous between `iec` and `iec-i`, `date -Is`
// resolves to `seconds` and `date --rfc-3339=` is ambiguous.
//
// Written as "<command> <canonical long spelling>" because that is how the
// measurement reads, but it NAMES the builtin `Option` objects rather
// than keying on the two strings: the parser resolves each entry once and
// then asks whether the option declaring a set IS one of them. A name is not
// identity, and a mount may register its own `tee` (commands/registry.ts)
// whose `--output-error` would otherwise inherit gnulib's rule from a
// spelling collision alone. Identity is also the only signal that survives
// registration, which hands the parser an enriched COPY of the spec
// (config.ts appends --help/--version), so `spec === BUILTIN_SPECS[name]` is
// false for every builtin by the time a line is parsed while every declared
// Option is still the same object. A command name never contains a space, so
// the joined key is unambiguous; python spells the same table as a set of
// pairs.
export const ARGMATCH_CHOICE_OPTIONS: ReadonlySet<string> = new Set([
  'tee --output-error',
  'numfmt --to',
  'numfmt --from',
  'date --iso-8601',
  'date --rfc-3339',
])

// Value shape accepted by an int-typed option: optional sign plus digits,
// the portable core of Python int() and argparse (no whitespace, no
// underscores, so both languages accept exactly the same strings).
export const INT_VALUE = /^[+-]?\d+$/
export const FLOAT_VALUE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

// GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
// and hostname 3.25 (plus ripgrep and jq upstream docs). Everything else
// exits 1.
// Commands whose `Try '--help'` hint line is prefixed with the command
// name (GNU diffutils style: `diff: Try 'diff --help' ...`).
export const USAGE_HINT_PREFIX: ReadonlySet<string> = new Set(['diff', 'cmp', 'patch'])

// An old-style cluster letter left without its argument exits 2, not
// USAGE_EXIT's 64: tar reads the cluster itself and raises its own fatal
// error, while 64 (EX_USAGE) is what argp returns for a letter it does
// not know. Pinned on GNU tar 1.35: `tar xzf` is 2, `tar -Q` is 64.
export const OLD_OPTION_EXIT = 2

// The exit code of a command refused on one operand before it ran (an
// admission policy's operand-scoped Deny): 1 for the GNU tools, which
// report an operand they cannot act on and exit 1, and tar's own fatal
// code, since tar reports an operand it cannot open and exits 2 (GNU tar
// 1.35, `Exiting with failure status due to previous errors`).
export const OPERAND_EXIT: Readonly<Record<string, number>> = Object.freeze({
  tar: 2,
})

export const USAGE_EXIT: Readonly<Record<string, number>> = Object.freeze({
  grep: 2,
  egrep: 2,
  fgrep: 2,
  zgrep: 2,
  rg: 2,
  ls: 2,
  sort: 2,
  diff: 2,
  cmp: 2,
  awk: 2,
  jq: 2,
  curl: 2,
  patch: 2,
  tar: 64,
  timeout: 125,
  hostname: 255,
  python: 2,
  python3: 2,
})

// The exit code a command answers when it cannot read an operand. GNU's
// code belongs to the COMMAND, not to the errno: `sort nope` and `sort
// dir` are both 2, `cat` is 1 for both. Absent means 1, which is what
// the executor's catch-all already did on its own. Pinned on
// debian:stable-slim (coreutils 9.7, GNU sed 4.9, gzip 1.13, jq 1.7,
// binutils 2.44, util-linux 2.41.5, bsdmainutils 12.1.8, xxd from
// vim-common). The python twin is READ_FAIL_EXIT in
// commands/spec/constants.py.
export const READ_FAIL_EXIT: Readonly<Record<string, number>> = Object.freeze({
  sort: 2,
  awk: 2,
  jq: 2,
  xxd: 2,
  grep: 2,
  egrep: 2,
  fgrep: 2,
  rg: 2,
  cmp: 2,
  diff: 2,
  sed: 2,
  zgrep: 2,
  unzip: 9,
})

// The commands whose code DOES depend on the errno, so the table above
// cannot express them on its own. sed opens the directory successfully and
// fails on the read, which is its own class (4), while a missing file fails at
// open (2). The gzip family reports a directory as a warning (2) and a missing
// file as an error (1). zgrep opens its operands itself, as `gzip -cdfq`
// does, and a pattern file it cannot read is exit 2 however it failed.
// Mirrors Python's READ_FAIL_EXIT_ISDIR.
export const READ_FAIL_EXIT_ISDIR: Readonly<Record<string, number>> = Object.freeze({
  sed: 4,
  gzip: 2,
  gunzip: 2,
  zcat: 2,
})

// The interpreter commands answer option errors in CPython's words, not
// GNU's: python3 is not a GNU tool, and its refusal names the
// source-selecting options a reader needs.
export const PYTHON_NAMES: ReadonlySet<string> = new Set(['python', 'python3'])

// Pinned on CPython 3.12.13, including two quirks worth keeping: the
// hint always spells the program `python` (never `python3`, whichever
// way it was invoked), and it quotes with a backquote/quote pair.
export function pythonUsage(name: string): string {
  return (
    `usage: ${name} [option] ... [-c cmd | -m mod | file | -] [arg] ...\n` +
    "Try `python -h' for more information.\n"
  )
}
