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

import { USAGE_EXIT } from './constants.ts'
import { operandSlot, optionMetavar } from '../spec/help.ts'
import { type CommandSpec, UsageStyle } from '../spec/types.ts'

export const ARGPARSE_EXIT = 2
export const CLAP_EXIT = 2
const LONG_PREFIX = '--'

const ENC = new TextEncoder()

/**
 * git's refusal for an option it does not know.
 *
 * Two nouns and no program name, pinned against git 2.50.1: a long option is an
 * "option" and a short one is a "switch", both named without their dashes and
 * quoted with a backquote-apostrophe pair. git follows this with the verb's
 * usage block, which is omitted the same way GNU's is elsewhere in the spec
 * machinery.
 *
 * @param token the offending token ('--nosuch') or cluster character ('Z'), as
 *   the flat parser reports it
 */
export function gitUnknownOption(token: string): Uint8Array {
  const noun = token.startsWith(LONG_PREFIX) ? 'option' : 'switch'
  return ENC.encode(`error: unknown ${noun} \`${token.replace(/^-+/, '')}'\n`)
}

/**
 * The options a clap usage line echoes back, in clap's order.
 *
 * clap reprints the options the line carried, in the order they were typed,
 * then the ones an environment variable supplied. A *defaulted* option is not
 * among them: pinned against ntn 0.21.9, whose --limit declares `[default: 25]`
 * and never appears unless it was typed.
 *
 * @param spec the leaf's grammar, for spellings and value names
 * @param typed dests the line carried, in scan order (canonical dashed
 *   spellings, the key space the parser records flags under)
 * @param env the session environment, read for the options that declare one
 */
export function clapSupplied(
  spec: CommandSpec,
  typed: readonly string[],
  env: Readonly<Record<string, string>>,
): string[] {
  const byDest = new Map(spec.options.map((opt) => [opt.long ?? opt.short ?? '', opt]))
  const bits: string[] = []
  for (const dest of typed) {
    const opt = byDest.get(dest)
    if (opt === undefined) continue
    bits.push(opt.type === 'bool' ? dest : `${dest} <${optionMetavar(opt)}>`)
  }
  for (const [dest, opt] of byDest) {
    if (opt.env === null || typed.includes(dest) || !(opt.env in env)) continue
    bits.push(`${dest} <${optionMetavar(opt)}>`)
  }
  return bits
}

/** Every operand slot of a leaf, as a clap usage line spells them. */
function clapOperands(spec: CommandSpec): string[] {
  const slots = spec.positional.map((operand) => operandSlot(operand))
  if (spec.rest !== null) slots.push(operandSlot(spec.rest, !spec.rest.required))
  return slots
}

/**
 * clap's refusal for required operands the line did not supply.
 *
 * Pinned against ntn 0.21.9: the empty slots are listed one per line under a
 * fixed heading, then a usage line that carries the options the line supplied
 * and every operand slot, then the "try --help" footer. The usage line names
 * only what was supplied, which is why it is rebuilt here rather than taken
 * from the help page.
 *
 * @param prog the full display path of the leaf ("ntn pages get")
 * @param spec the leaf's grammar
 * @param missing bare names of the empty required slots
 * @param typed dests the line carried, in scan order
 * @param env the session environment
 */
export function clapMissingOperands(
  prog: string,
  spec: CommandSpec,
  missing: readonly string[],
  typed: readonly string[],
  env: Readonly<Record<string, string>>,
): Uint8Array {
  const named = missing.map((name) => `  <${name}>`).join('\n')
  const usage = [prog, ...clapSupplied(spec, typed, env), ...clapOperands(spec)].join(' ')
  return ENC.encode(
    'error: the following required arguments were not provided:\n' +
      `${named}\n\nUsage: ${usage}\n\n` +
      "For more information, try '--help'.\n",
  )
}

/**
 * The message and exit code a leaf answers a bad option with.
 *
 * A leaf usage error exits 2 under argparse's style regardless of the GNU
 * USAGE_EXIT table, because an installed CLI name is never a GNU tool with its
 * own pinned exit. git exits 129 for the same mistake, which is neither that
 * nor its own 128 for a fatal. clap exits 2, agreeing with argparse by
 * coincidence rather than by lineage.
 *
 * @param style the dialect the CLI's root declares
 * @param argparseMessage the message the spec machinery built, used as-is for
 *   argparse and for anything git words the same
 * @param invalidOptions the offending tokens the parser reported, read when the
 *   style rewrites the message
 */
export function leafRefusal(
  style: UsageStyle,
  argparseMessage: Uint8Array,
  invalidOptions: readonly string[],
): [Uint8Array, number] {
  if (style === UsageStyle.CLAP) return [argparseMessage, CLAP_EXIT]
  if (style !== UsageStyle.GIT) return [argparseMessage, ARGPARSE_EXIT]
  const first = invalidOptions[0]
  if (first !== undefined) return [gitUnknownOption(first), USAGE_EXIT]
  return [argparseMessage, USAGE_EXIT]
}
