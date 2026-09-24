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
])

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

// Commands whose `Try '--help'` hint line is prefixed with the command
// name (GNU diffutils style: `diff: Try 'diff --help' ...`), on every
// refusal that carries the hint. Read only for the builtin's own grammar,
// so the prefix follows the grammar and not the spelling (see USAGE_EXIT).
export const USAGE_HINT_PREFIX: ReadonlySet<string> = new Set(['diff', 'cmp'])

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
//
// Keyed on the name alone because the admission gate reads it before
// `resolveMount` has chosen a mount, so no spec exists there yet (the same
// reason the router's link tables in workspace/lookup/constants.ts are
// name-keyed), and it only picks an exit code.
export const OPERAND_EXIT: Readonly<Record<string, number>> = Object.freeze({
  tar: 2,
})

// GNU usage-error exit codes, pinned against debian coreutils/grep/diffutils
// (plus ripgrep and jq upstream docs). Everything else exits 1.
//
// This table, USAGE_HINT_PREFIX and PYTHON_NAMES (and the curl and find
// voices worded in usage.ts) each describe one real program, so usage.ts
// reads them only when the line was parsed against the builtin's own
// grammar (the parse's `builtin` bit, `isBuiltinGrammar`): a mount's own `grep`
// exits 1 in the generic voice rather than inheriting grep's 2 from a
// spelling collision. The tables that stay keyed on the name alone are the
// ones read where no spec exists yet, and say so.
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
  tar: 64,
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
//
// Deliberately keyed on the name alone, unlike USAGE_EXIT. It only picks an
// exit code, it is reached only when a handler throws the very errno the
// builtin would, and three of its eight readers (the lazy-stream drains in
// executor/statement.ts, executor/redirect.ts and node/program.ts) know the
// command only as `ExecutionNode.command`, a string, long after the spec was
// in hand. Gating the five that could know would make one borrowed `sort`
// answer 1 eagerly and 2 lazily, a split GNU does not have, and closing it
// means a new field on the execution record for an exit code.
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

// The four commands whose code DOES depend on the errno, so the table
// above cannot express them on its own. sed opens the directory
// successfully and fails on the read, which is its own class (4), while a
// missing file fails at open (2). The gzip family reports a directory as
// a warning (2) and a missing file as an error (1). zgrep inverts that,
// because its exit code is grep's: a directory it cannot decompress
// yields no match (1) where a missing file is grep's own error (2).
export const READ_FAIL_EXIT_ISDIR: Readonly<Record<string, number>> = Object.freeze({
  sed: 4,
  gzip: 2,
  gunzip: 2,
  zcat: 2,
  zgrep: 1,
})

// The interpreter commands answer option errors in CPython's words, not
// GNU's: python3 is not a GNU tool, and its refusal names the
// source-selecting options a reader needs. Read only for the builtin's own
// grammar, so a mount's own `python3` is refused in GNU's words like any
// other custom command (see USAGE_EXIT).
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
