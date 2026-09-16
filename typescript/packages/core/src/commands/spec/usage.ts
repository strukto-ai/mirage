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

import { UsageError } from '../errors.ts'
import { quoteText } from '../quote.ts'
import { gnuStrerror } from '../../utils/errors.ts'
import {
  OLD_OPTION_EXIT,
  OPERAND_EXIT,
  PYTHON_NAMES,
  pythonUsage,
  READ_FAIL_EXIT,
  READ_FAIL_EXIT_ISDIR,
  USAGE_EXIT,
  USAGE_HINT_PREFIX,
} from './constants.ts'
import { CommandName } from './types.ts'

/** GNU usage-error exit code for a command. */
export function usageExitCode(cmdName: string): number {
  return USAGE_EXIT[cmdName] ?? 1
}

/** Exit code of a command refused on one operand before it ran. */
export function operandExitCode(cmdName: string): number {
  return OPERAND_EXIT[cmdName] ?? 1
}

/**
 * The exit code for a command that could not read an operand.
 *
 * Read off the command, not off the errno, because that is how GNU's own
 * codes fall; the errno is consulted only for the four commands that do
 * answer a directory and a missing file differently. Mirrors the python
 * `read_fail_exit`.
 *
 * Gated on READ_FAIL_CODES, and nothing wider: the tables are keyed by
 * command and the executor's chokepoints catch everything a command can
 * throw, so a loose gate makes them answer in the wrong voice. Two cases
 * set the width. A bad script is not a filesystem error at all (`sed
 * 's/o/O/0'` is exit 1, not sed's 2). And EACCES is as often a WRITE
 * refusal as a read one (`sed -i` on a read-only backend is exit 1, not
 * 4), which the chokepoint cannot tell apart. EACCES on a genuine read is
 * the one case this leaves at 1 where GNU would answer the command's
 * code; that is the safe side, and it is what the executor already did
 * before the tables existed.
 */
const READ_FAIL_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

function readFailCode(cmdName: string, isDir: boolean): number {
  if (isDir) {
    const isdir = READ_FAIL_EXIT_ISDIR[cmdName]
    if (isdir !== undefined) return isdir
  }
  return READ_FAIL_EXIT[cmdName] ?? 1
}

export function readFailExitCode(cmdName: string, err: unknown): number {
  const code = (err as { code?: string }).code
  if (code === undefined || !READ_FAIL_CODES.has(code)) return 1
  return readFailCode(cmdName, code === 'EISDIR')
}

/**
 * The code one rendered stderr line's terminal errno asks for.
 *
 * Read off the LAST field, not searched for anywhere in the line: the
 * renderer writes `<cmd>: <path>: <strerror>` and a path is free to spell
 * a strerror itself, so a directory named `No such file or directory` read
 * as ENOENT under a global scan and sed answered 2 where GNU answers 4.
 * Null when the terminal field is not a strerror this family knows, which
 * is what a line that is not a failed read looks like.
 */
function lineReadFailCode(cmdName: string, line: string): number | null {
  const cut = line.lastIndexOf(': ')
  const terminal = cut === -1 ? line : line.slice(cut + 2)
  for (const code of READ_FAIL_CODES) {
    if (gnuStrerror(code) === terminal) return readFailCode(cmdName, code === 'EISDIR')
  }
  return null
}

/**
 * The same code, for a read failure known only as a rendered line.
 *
 * The cross-mount stream path fetches each operand with a native `cat`
 * sub-run, so a failed operand arrives as cat's rendered stderr rather
 * than as an error. That line is already respelled into the real
 * command's voice, and the exit code has to follow it or `sort a
 * /other/missing` answers 1 while `sort missing` answers 2, a split GNU
 * does not have. Classified against the very strerrors the renderer
 * wrote, so the forward and backward directions cannot drift; a blob that
 * carries no failed-read line keeps the catch-all 1.
 *
 * One fetch can render several lines, because one operand can be a glob
 * the owning mount expanded, and the most severe code is the answer: sed
 * is the only stream command whose code depends on the errno, and its rule
 * is the most severe (4 beats 2), which is also how the caller folds one
 * operand's code into the next.
 *
 * Mirrors the python `read_fail_exit_line`.
 */
export function readFailExitCodeFromLine(cmdName: string, rendered: string): number {
  let code = 0
  for (const line of rendered.split('\n')) {
    const one = lineReadFailCode(cmdName, line)
    if (one !== null) code = Math.max(code, one)
  }
  return code || 1
}

/**
 * GNU-shaped error for an option the spec does not declare.
 *
 * Shapes pinned against real GNU: long options report the full token
 * (`cat: unrecognized option '--bogus=x'`), short options report the
 * offending character (`cat: invalid option -- 'Y'`), and find uses its
 * predicate wording with backquote quoting. GNU's per-tool usage dumps
 * are deliberately omitted; the `--help` hint line is kept because every
 * registered command serves `--help`.
 */
function pythonOptionError(cmdName: string, line: string): [Uint8Array, number] {
  return [new TextEncoder().encode(line + pythonUsage(cmdName)), usageExitCode(cmdName)]
}

/**
 * curl's option refusal: one message line, then its own help hint.
 *
 * Pinned on curl 8.14.1 (debian:stable-slim). One divergence: curl names
 * a whole cluster with a bad letter (`option -sW: is unknown`) where the
 * parser reports the letter, so mirage says `option -W`.
 */
export function curlOptionError(line: string): [Uint8Array, number] {
  const hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"
  return [new TextEncoder().encode(line + hint), usageExitCode('curl')]
}

export function unknownOptionError(cmdName: string, token: string): [Uint8Array, number] {
  if (cmdName === 'curl') {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return curlOptionError(`curl: option ${dashed}: is unknown\n`)
  }
  if (cmdName === (CommandName.FIND as string)) {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return [
      new TextEncoder().encode(`find: unknown predicate \`${dashed}'\n`),
      usageExitCode(cmdName),
    ]
  }
  if (PYTHON_NAMES.has(cmdName)) {
    // CPython's own two shapes, which do not match each other: the short
    // form capitalizes and takes a colon, the long form does neither.
    // Both pinned on 3.12.13.
    if (token.startsWith('--')) {
      return pythonOptionError(cmdName, `unknown option ${token}\n`)
    }
    const dashed = token.startsWith('-') ? token : `-${token}`
    return pythonOptionError(cmdName, `Unknown option: ${dashed}\n`)
  }
  const line = token.startsWith('--')
    ? `${cmdName}: unrecognized option '${token}'\n`
    : `${cmdName}: invalid option -- '${token}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

// The programs that do NOT parse with getopt_long, and so answer an option
// they will not take by naming the whole typed token as unknown rather than by
// naming the option. Each one is measured: `curl --silent=2` is
// `curl: option --silent=2: is unknown`, `python3 --version=2` is
// `unknown option --version=2`, `jq --tab=2` is `jq: Unknown option --tab=2`,
// and find reads the word as a predicate. Every other command here is a GNU
// tool whose getopt_long words the refusal the other way, so the set is the
// exception list and not the rule.
const NOT_GETOPT_LONG = new Set<string>(['curl', 'jq', CommandName.FIND, ...PYTHON_NAMES])

/**
 * getopt_long refusal for a BOOLEAN long option handed a value.
 *
 * `grep --byte-offset=2` is not an unrecognized option -- getopt_long
 * recognized it perfectly well and refused the `=2`, so the message names the
 * option and drops the value, where the unrecognized-option message quotes the
 * whole token including it. It also names the CANONICAL spelling, not the one
 * that was typed: `grep --byte=2` answers for `--byte-offset`. Shape pinned
 * against GNU grep 3.11 and coreutils 9.4 (`grep --byte-offset=2`,
 * `grep --line-buffered=2`, `nl --help=2`, `cut --complement=2`,
 * `sed --debug=2`), all exit 2 for grep and sort and 1 for the coreutils.
 *
 * GNU's per-tool usage dump is deliberately omitted, exactly as
 * unknownOptionError omits it; grep and sed print theirs between the message
 * and the hint, coreutils print none at all.
 *
 * `token` is the option's canonical long spelling and the value that was typed
 * on it ('--byte-offset=2'). It is carried whole because the programs in
 * NOT_GETOPT_LONG quote the value along with the option and getopt_long drops
 * it.
 */
export function unexpectedValueError(cmdName: string, token: string): [Uint8Array, number] {
  if (NOT_GETOPT_LONG.has(cmdName)) return unknownOptionError(cmdName, token)
  const option = token.split('=', 1)[0] ?? token
  const line = `${cmdName}: option '${option}' doesn't allow an argument\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/**
 * getopt_long refusal for an abbreviated long matching several options.
 *
 * Shape pinned against real GNU (`grep --c`): the typed spelling, then
 * every possibility quoted in declaration order on one line. The
 * per-tool usage dump GNU appends is deliberately omitted, like
 * unknownOptionError.
 */
export function ambiguousOptionError(
  cmdName: string,
  token: string,
  candidates: readonly string[],
): [Uint8Array, number] {
  const listed = candidates.map((c) => `'${c}'`).join(' ')
  const line = `${cmdName}: option '${token}' is ambiguous; possibilities: ${listed}\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/**
 * Refusal for a non-integer value on an int-typed option.
 *
 * No GNU tool declares types through getopt (each words its own refusal,
 * e.g. `head: invalid number of lines`), so this mirrors argparse's
 * `invalid int value: 'abc'` with the option attributed the way
 * invalidArgumentError does.
 */
export function invalidIntError(
  cmdName: string,
  option: string,
  value: string,
): [Uint8Array, number] {
  const line = `${cmdName}: invalid int value: '${value}' for '${option}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/**
 * Refusal for a non-number value on a float-typed option. Mirrors
 * argparse's `invalid float value: '5x'` the same way invalidIntError
 * mirrors the int wording.
 */
export function invalidFloatError(
  cmdName: string,
  option: string,
  value: string,
): [Uint8Array, number] {
  if (cmdName === 'curl') {
    return curlOptionError(`curl: option ${option}: expected a proper numerical parameter\n`)
  }
  const line = `${cmdName}: invalid float value: '${value}' for '${option}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/** GNU-shaped error for a declared value flag with no argument left. */
export function missingValueError(cmdName: string, token: string): [Uint8Array, number] {
  if (PYTHON_NAMES.has(cmdName)) {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return pythonOptionError(cmdName, `Argument expected for the ${dashed} option\n`)
  }
  if (cmdName === 'curl') {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return curlOptionError(`curl: option ${dashed}: requires parameter\n`)
  }
  const line = token.startsWith('--')
    ? `${cmdName}: option '${token}' requires an argument\n`
    : `${cmdName}: option requires an argument -- '${token}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/**
 * GNU tar refusal for an old-style cluster letter with no argument.
 *
 * First line and exit pinned against GNU tar 1.35 (`tar xzf` with
 * nothing after it, and `tar cfC a.tar`, which names C). tar's own
 * wording, capital and full stop included, because it counts the
 * cluster's argument needs before argp sees the line at all.
 *
 * The hint line is deliberately mirage's, not GNU's: GNU offers
 * `Try 'tar --help' or 'tar --usage' for more information.` because argp
 * gives every argp program a `--usage`, and mirage's tar serves only
 * `--help`. Naming a flag that does not exist would be worse than the
 * shorter hint, and every other refusal here words it this way, so tar's
 * two refusals stay consistent with each other.
 */
export function oldOptionError(cmdName: string, letter: string): [Uint8Array, number] {
  const line = `${cmdName}: Old option '${letter}' requires an argument.\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), OLD_OPTION_EXIT]
}

// One ARGMATCH candidate: a bare name, or a group of spellings that
// gnulib's argmatch maps to the SAME value. The group is not cosmetic --
// `argmatch_valid` starts a new `  - ` line only when the value changes and
// joins the aliases of one value with `, `, which is why GNU answers
// `sort --check=x` with `  - 'quiet', 'silent'` on one line and
// `  - 'diagnose-first'` on the next.
//
// `ArgmatchChoices` in usage.py is the twin.
type ArgmatchChoices = readonly (string | readonly string[])[]

/**
 * The first line of a gnulib ARGMATCH refusal, without its newline.
 *
 * Two wordings, and the empty word picks the second: gnulib's `argmatch`
 * matches on a prefix, so `''` is a prefix of every candidate and comes
 * back ambiguous rather than invalid. Measured on coreutils 9.4 at every
 * argmatch slot in the repo (`tail --follow=`, `sort --check=`,
 * `wc --total=`, `uniq --all-repeated=`, `uniq --group=`, `ls --format=`,
 * `ls -l --time-style=`, `cp --update=`, `tee --output-error=`), all of
 * which answer `ambiguous argument ''`. `du --max-depth=` is NOT argmatch
 * and says `invalid maximum depth ''`, which is why that one is worded in
 * du.
 *
 * The word is rendered through `quoteText`, gnulib's own `quote()`:
 * `tee --output-error=xé` is `invalid argument 'x\303\251'`. Callers must
 * therefore pass the value as typed and never pre-escape it.
 *
 * `argmatch_line` in usage.py is the twin.
 */
export function argmatchLine(cmdName: string, option: string, value: string): string {
  const kind = value === '' ? 'ambiguous' : 'invalid'
  return `${cmdName}: ${kind} argument '${quoteText(value)}' for '${option}'`
}

/** gnulib's `Valid arguments are:` block, without a trailing newline. */
export function argmatchValidBlock(choices: ArgmatchChoices): string {
  const rows = choices.map((choice) => {
    const group = typeof choice === 'string' ? [choice] : choice
    return '  - ' + group.map((c) => `'${c}'`).join(', ')
  })
  return 'Valid arguments are:\n' + rows.join('\n')
}

/**
 * GNU ARGMATCH refusal for a value outside a declared choices set.
 *
 * Shape pinned against real GNU (`tee --output-error=bogus`): the
 * offending value, the option's canonical long spelling, then every valid
 * argument in declaration order, aliases of one value on one line, then
 * the `Try '--help'` hint.
 *
 * `exitCode` undefined takes the command's own usage code, which is 1 for
 * every command that reaches this renderer through the executor. ls and
 * sort pass 1 explicitly: gnulib's `argmatch_die` always calls
 * `usage (EXIT_FAILURE)`, so their argmatch refusals are 1 even though
 * their other usage errors are 2.
 */
export function invalidArgumentError(
  cmdName: string,
  option: string,
  value: string,
  choices: ArgmatchChoices,
  exitCode?: number,
): [Uint8Array, number] {
  const line = `${argmatchLine(cmdName, option, value)}\n${argmatchValidBlock(choices)}\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  const code = exitCode ?? usageExitCode(cmdName)
  return [new TextEncoder().encode(line + hint), code]
}

/**
 * `invalidArgumentError` as the error a command throws.
 *
 * The commands that validate an ARGMATCH value themselves (`sort`, `wc`,
 * `uniq`, `ls`, `cp`, `tail`) hold the value long after the parser is done
 * with it, so they render through the same function the executor does
 * rather than wording a second copy.
 *
 * `argmatch_error` in usage.py is the twin.
 */
export function argmatchError(
  cmdName: string,
  option: string,
  value: string,
  choices: ArgmatchChoices,
  exitCode?: number,
): UsageError {
  const [message, code] = invalidArgumentError(cmdName, option, value, choices, exitCode)
  return new UsageError(new TextDecoder().decode(message).replace(/\n+$/, ''), code)
}

/**
 * Refusal for a declared required option absent from the line.
 *
 * No GNU tool declares required options through getopt, so there is no
 * GNU shape to pin; this follows the unrecognized-option pattern (click
 * reports the same condition as "Missing option").
 */
export function missingRequiredError(cmdName: string, option: string): [Uint8Array, number] {
  const line = `${cmdName}: option '${option}' is required\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/**
 * The `Try '<cmd> --help'` line as that command prints it.
 *
 * coreutils writes the hint bare; diffutils routes it through `error()`,
 * so cmp and diff carry the command prefix on the hint line too.
 */
export function usageHint(cmdName: string): string {
  const prefix = USAGE_HINT_PREFIX.has(cmdName) ? `${cmdName}: ` : ''
  return `${prefix}Try '${cmdName} --help' for more information.`
}

/**
 * GNU-shaped usage error for an operand past a command's arity.
 *
 * Shapes pinned against real GNU: `<cmd>: extra operand '<arg>'` with the
 * `Try '--help'` hint (diff and cmp prefix the hint line with the command
 * name; mktemp says `too many templates` with no operand). The operand must
 * be the as-typed spelling (`rawPath`), never the resolved path.
 */
export function extraOperandError(cmdName: string, operand: string): UsageError {
  const line =
    cmdName === (CommandName.MKTEMP as string)
      ? 'mktemp: too many templates'
      : `${cmdName}: extra operand '${operand}'`
  return new UsageError(`${line}\n${usageHint(cmdName)}`, usageExitCode(cmdName))
}
