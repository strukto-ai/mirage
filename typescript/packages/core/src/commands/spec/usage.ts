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
import { OLD_OPTION_EXIT, USAGE_EXIT, USAGE_HINT_PREFIX } from './constants'
import { CommandName } from './types.ts'

/** GNU usage-error exit code for a command. */
export function usageExitCode(cmdName: string): number {
  return USAGE_EXIT[cmdName] ?? 1
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
export function unknownOptionError(cmdName: string, token: string): [Uint8Array, number] {
  if (cmdName === (CommandName.FIND as string)) {
    const dashed = token.startsWith('-') ? token : `-${token}`
    return [
      new TextEncoder().encode(`find: unknown predicate \`${dashed}'\n`),
      usageExitCode(cmdName),
    ]
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
  const line = `${cmdName}: invalid float value: '${value}' for '${option}'\n`
  const hint = `Try '${cmdName} --help' for more information.\n`
  return [new TextEncoder().encode(line + hint), usageExitCode(cmdName)]
}

/** GNU-shaped error for a declared value flag with no argument left. */
export function missingValueError(cmdName: string, token: string): [Uint8Array, number] {
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
  const prefix = USAGE_HINT_PREFIX.has(cmdName) ? `${cmdName}: ` : ''
  const hint = `${prefix}Try '${cmdName} --help' for more information.`
  return new UsageError(`${line}\n${hint}`, usageExitCode(cmdName))
}
