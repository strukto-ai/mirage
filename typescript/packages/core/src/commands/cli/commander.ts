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

// Follows commander 15.1.0's usage refusals and the close-match suggestion of
// its lib/suggestSimilar.js (MIT; see licenses/third_party/commander.txt), the
// parser tvly 1.0.2 is built on.

import type { Argument, CommandSpec } from '../spec/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'

// tvly exits 2 for every refusal commander raises (src/cli.ts maps each
// CommanderError to it); commander left alone exits 1.
export const COMMANDER_EXIT = 2
const MAX_DISTANCE = 3
const MIN_SIMILARITY = 0.4
const HELP_LONG = '--help'

/**
 * Optimal string alignment distance: insertions, deletions, substitutions and
 * adjacent transpositions, none edited twice.
 */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > MAX_DISTANCE) return Math.max(a.length, b.length)
  const width = b.length + 1
  const d = new Array<number>((a.length + 1) * width).fill(0)
  const at = (i: number, j: number): number => d[i * width + j] ?? 0
  for (let i = 0; i <= a.length; i++) d[i * width] = i
  for (let j = 0; j <= b.length; j++) d[j] = j
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1)
      }
      d[i * width + j] = best
    }
  }
  return at(a.length, b.length)
}

/**
 * The `(Did you mean ...?)` line for a word close to a candidate, or nothing;
 * only the candidates at the best distance are named.
 */
export function suggestSimilar(word: string, candidates: readonly string[]): string {
  let pool = [...new Set(candidates)]
  if (pool.length === 0) return ''
  const options = word.startsWith('--')
  let typed = word
  if (options) {
    typed = word.slice(2)
    pool = pool.map((candidate) => candidate.slice(2))
  }
  let similar: string[] = []
  let best = MAX_DISTANCE
  for (const candidate of pool) {
    if (candidate.length <= 1) continue
    const distance = editDistance(typed, candidate)
    const length = Math.max(typed.length, candidate.length)
    if ((length - distance) / length > MIN_SIMILARITY) {
      if (distance < best) {
        best = distance
        similar = [candidate]
      } else if (distance === best) {
        similar.push(candidate)
      }
    }
  }
  similar.sort(compareCodePoints)
  if (options) similar = similar.map((candidate) => `--${candidate}`)
  if (similar.length > 1) return `\n(Did you mean one of ${similar.join(', ')}?)`
  if (similar.length === 1) return `\n(Did you mean ${similar[0] ?? ''}?)`
  return ''
}

/** Every long option the nodes declare, `--help` among them, the candidates commander suggests from. */
export function longOptions(nodes: readonly CommandSpec[]): string[] {
  const names: string[] = []
  for (const node of nodes) {
    for (const argument of node.arguments) {
      names.push(...argument.names.filter((name) => name.startsWith('--')))
    }
    names.push(HELP_LONG)
  }
  return names
}

/**
 * The option as commander spells it in a refusal: its names, then `<value>`
 * for a value it needs or `[value]` for one it may take.
 */
export function optionFlags(argument: Argument): string {
  const names = argument.names.join(', ')
  if (argument.action === 'store_true' || argument.action === 'count') return names
  const value =
    argument.metavar ?? (argument.names[argument.names.length - 1] ?? '').replace(/^-+/, '')
  let start = 0
  let end = value.length
  while (start < end && '<>[]'.includes(value.charAt(start))) start += 1
  while (end > start && '<>[]'.includes(value.charAt(end - 1))) end -= 1
  const bare = value.slice(start, end)
  return `${names} ${argument.nargs === '?' ? `[${bare}]` : `<${bare}>`}`
}

/** The refusal of an option no node declares. */
export function unknownOption(token: string, nodes: readonly CommandSpec[]): string {
  const suggestion = token.startsWith('--') ? suggestSimilar(token, longOptions(nodes)) : ''
  return `error: unknown option '${token}'${suggestion}\n`
}

/** The refusal of an option typed last with no value after it. */
export function missingValue(token: string, node: CommandSpec): string | null {
  for (const argument of node.arguments) {
    if (argument.names.includes(token)) {
      return `error: option '${optionFlags(argument)}' argument missing\n`
    }
  }
  return null
}

/** The refusal of operands a command with none declared was given. */
export function excessArguments(words: readonly string[], verb?: string): string {
  const target = verb === undefined ? '' : ` for '${verb}'`
  return (
    `error: too many arguments${target}. Expected 0 arguments but got ` +
    `${String(words.length)}: ${words.join(', ')}.\n`
  )
}
