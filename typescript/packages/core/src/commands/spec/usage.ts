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
import { USAGE_EXIT, USAGE_HINT_PREFIX } from './constants'
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

/** GNU-shaped error for a declared value flag with no argument left. */
export function missingValueError(cmdName: string, token: string): [Uint8Array, number] {
  const line = token.startsWith('--')
    ? `${cmdName}: option '${token}' requires an argument\n`
    : `${cmdName}: option requires an argument -- '${token}'\n`
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
