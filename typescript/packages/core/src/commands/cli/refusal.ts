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

import {
  CLAP_EXIT,
  GIT_LONG_OPTIONS,
  GIT_SYNOPSES,
  GIT_USAGE_GAP,
  GIT_USAGE_WIDTH,
  USAGE_EXIT,
} from './constants.ts'
import { operandSlot, optionMetavar } from '../spec/help.ts'
import { type CommandSpec, UsageStyle } from '../spec/types.ts'
import type { ParsedCommand } from '../../workspace/executor/command/types.ts'

export const ARGPARSE_EXIT = 2
const LONG_PREFIX = '--'
const NEGATION = '--no-'
export const HELP_SWITCH = '-h'

const ENC = new TextEncoder()

/**
 * git's usage block for one verb, as parse-options prints it.
 *
 * The synopsis lines come first, the first after `usage: ` and each next one
 * after `   or: `, then a blank line, one row per option and a closing blank
 * line. The lines are git's own (`GIT_SYNOPSES`); the rows are the leaf's spec
 * in git's layout, so the block lists exactly the options mirage takes: four
 * spaces, the short and long spellings, `--[no-]` where the spec declares a
 * long's negation beside it, the value's name, then the description from
 * column 26, or under that column on a line of its own when the spellings run
 * past it. Pinned against git 2.47.3.
 *
 * @param path the verb's path under git ('branch', 'stash list')
 * @param spec the leaf's grammar
 */
export function gitUsage(path: string, spec: CommandSpec): string {
  const [first, ...rest] = GIT_SYNOPSES.get(path) ?? [`git ${path}`]
  let text = `usage: ${first ?? ''}\n` + rest.map((line) => `   or: ${line}\n`).join('')
  const rows = gitRows(path, spec)
  if (rows.length > 0) text += '\n' + rows.join('')
  return text + '\n'
}

/**
 * One usage row per option, a negation folded where git folds it.
 *
 * git spells a long `--[no-]name` where its own table does
 * (`GIT_LONG_OPTIONS`), and the row then stands for the plain boolean
 * `--no-name` mirage declares beside it too. A `--no-` option git lists apart
 * (`--no-merges` filters rather than negates) keeps a row of its own.
 *
 * @param path the verb's path under git, for its table
 * @param spec the leaf's grammar
 */
function gitRows(path: string, spec: CommandSpec): string[] {
  const table = GIT_LONG_OPTIONS.get(path) ?? []
  const negations = new Set(
    spec.options
      .filter(
        (opt) =>
          opt.long?.startsWith(NEGATION) === true &&
          opt.short === null &&
          opt.type === 'bool' &&
          table.includes(`[no-]${opt.long.slice(NEGATION.length)}`),
      )
      .map((opt) => opt.long),
  )
  const rows: string[] = []
  for (const opt of spec.options) {
    let long = opt.long
    if (long !== null && negations.has(long)) continue
    if (long !== null && negations.has(`${NEGATION}${long.slice(2)}`)) {
      long = `--[no-]${long.slice(2)}`
    }
    let spelled = [opt.short, long].filter((name) => name !== null).join(', ')
    if (opt.type !== 'bool') {
      const named = opt.long !== null ? opt.long.slice(2) : (opt.short ?? '-').slice(1)
      const value = `<${opt.metavar ?? named}>`
      if (!opt.valueOptional) spelled += ` ${value}`
      else spelled += opt.long !== null ? `[=${value}]` : `[${value}]`
    }
    const left = `    ${spelled}`
    const gap =
      left.length <= GIT_USAGE_WIDTH + 1
        ? ' '.repeat(GIT_USAGE_WIDTH + GIT_USAGE_GAP - left.length)
        : '\n' + ' '.repeat(GIT_USAGE_WIDTH + GIT_USAGE_GAP)
    rows.push(`${left}${gap}${opt.description ?? ''}\n`)
  }
  return rows
}

/**
 * parse-options' answer to a word the verb does not take.
 *
 * `-h` asks for the usage block, which goes to stdout. A boolean long handed a
 * value is refused on one line. Anything else is an option the verb does not
 * have: a long one is an "option" and a short one a "switch", both named
 * without their dashes and quoted with a backquote-apostrophe pair, and the
 * usage block follows on stderr. Pinned against git 2.50.1.
 *
 * @param word the offending word with its dashes ('--nosuch', '-Z',
 *   '--quiet=1')
 * @param path the verb's path under git, for its synopsis
 * @param spec the leaf's grammar, for its rows
 * @returns the refusal's stdout and its stderr; it exits 129
 */
export function gitOptionRefusal(word: string, path: string, spec: CommandSpec): [string, string] {
  const usage = gitUsage(path, spec)
  if (word === HELP_SWITCH) return [usage, '']
  const eq = word.indexOf('=')
  const name = eq === -1 ? word : word.slice(0, eq)
  if (eq !== -1 && spec.options.some((opt) => opt.long === name && opt.type === 'bool')) {
    return ['', `error: option \`${name.slice(2)}' takes no value\n`]
  }
  const noun = word.startsWith(LONG_PREFIX) ? 'option' : 'switch'
  return ['', `error: unknown ${noun} \`${word.replace(/^-+/, '')}'\n${usage}`]
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
 * git answers in parse-options' words, and some of them print the verb's
 * usage block: after an unknown option on stderr, on stdout for `-h` and after
 * an ambiguous abbreviation. A missing value is one line, a long named an
 * "option" and a short one a "switch" (pinned against git 2.50.1).
 *
 * @param style the dialect the CLI's root declares
 * @param argparseMessage the message the spec machinery built, used as-is for
 *   argparse and for anything another style words the same
 * @param parsed the parse, read for the offending tokens when the style
 *   rewrites the message
 * @param path the leaf's path under its head word, for git's synopsis
 * @param spec the leaf's grammar, for git's option rows
 * @returns the stderr, the exit code and the stdout, null when the refusal
 *   writes nothing there
 */
export function leafRefusal(
  style: UsageStyle,
  argparseMessage: Uint8Array,
  parsed: Pick<
    ParsedCommand,
    'invalidOptions' | 'ambiguousOptions' | 'optionErrorKinds' | 'needsValueOptions'
  >,
  path: string,
  spec: CommandSpec,
): [Uint8Array, number, Uint8Array | null] {
  if (style === UsageStyle.CLAP) return [argparseMessage, CLAP_EXIT, null]
  if (style !== UsageStyle.GIT) return [argparseMessage, ARGPARSE_EXIT, null]
  const kind = parsed.optionErrorKinds[0]
  const ambiguous = parsed.ambiguousOptions[0]
  if (kind === 'ambiguous' && ambiguous !== undefined) {
    const [token, [first = '', second = '']] = ambiguous
    const line = `error: ambiguous option: ${token.slice(2)} (could be ${first} or ${second})\n`
    return [ENC.encode(line), USAGE_EXIT, ENC.encode(gitUsage(path, spec))]
  }
  const needy = parsed.needsValueOptions[0]
  if (kind === 'needs_value' && needy !== undefined) {
    const named = needy.startsWith(LONG_PREFIX)
      ? `option \`${needy.slice(2)}'`
      : `switch \`${needy.replace(/^-+/, '')}'`
    return [ENC.encode(`error: ${named} requires a value\n`), USAGE_EXIT, null]
  }
  const token = parsed.invalidOptions[0]
  if ((kind === 'invalid' || kind === 'unexpected_value') && token !== undefined) {
    const word = token.startsWith('-') ? token : `-${token}`
    const [shown, refused] = gitOptionRefusal(word, path, spec)
    return [ENC.encode(refused), USAGE_EXIT, shown !== '' ? ENC.encode(shown) : null]
  }
  return [argparseMessage, USAGE_EXIT, null]
}
