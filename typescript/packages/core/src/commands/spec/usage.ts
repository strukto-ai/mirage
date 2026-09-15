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

/**
 * GNU ARGMATCH refusal for a value outside a declared choices set.
 *
 * Shape pinned against real GNU (`tee --output-error=bogus`): the
 * offending value, the option's canonical long spelling, then every valid
 * argument in declaration order, one per line.
 */
export function invalidArgumentError(
  cmdName: string,
  option: string,
  value: string,
  choices: readonly string[],
): [Uint8Array, number] {
  const valid = choices.map((c) => `  - '${c}'`).join('\n')
  const line =
    `${cmdName}: invalid argument '${value}' for '${option}'\n` + `Valid arguments are:\n${valid}\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
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
