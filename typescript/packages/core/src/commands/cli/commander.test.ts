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

import { describe, expect, it } from 'vitest'
import { Argument, CommandSpec } from '../spec/types.ts'
import {
  editDistance,
  excessArguments,
  missingValue,
  optionFlags,
  suggestSimilar,
  unknownOption,
} from './commander.ts'

const LEAF = new CommandSpec({
  name: 'search',
  arguments: [
    new Argument('--depth', { metavar: 'value' }),
    new Argument('--max-results', { metavar: 'n' }),
    new Argument('--max-chars', { metavar: 'n' }),
    new Argument(['-o', '--output'], { nargs: '?', metavar: 'file' }),
    new Argument('--json', { action: 'store_true' }),
  ],
})

function argumentAt(index: number): Argument {
  const found = LEAF.arguments[index]
  if (found === undefined) throw new Error(`LEAF has no argument ${String(index)}`)
  return found
}

// Mirrors python's tests/commands/cli/test_commander.py.
describe("commander's refusals", () => {
  it('counts a transposition as one edit', () => {
    expect(editDistance('dpeth', 'depth')).toBe(1)
    expect(editDistance('dept', 'depth')).toBe(1)
    expect(editDistance('abc', 'abcdefgh')).toBe(8)
  })

  it('suggests the closest option', () => {
    expect(suggestSimilar('--dept', ['--depth', '--json'])).toBe('\n(Did you mean --depth?)')
  })

  it('names every option at the same distance, in order', () => {
    expect(suggestSimilar('--max-char', ['--max-results', '--max-chars'])).toBe(
      '\n(Did you mean --max-chars?)',
    )
    expect(suggestSimilar('--ab', ['--ac', '--aa'])).toBe('\n(Did you mean one of --aa, --ac?)')
  })

  it('suggests nothing when nothing is close', () => {
    expect(suggestSimilar('--zzzzzz', ['--depth', '--json'])).toBe('')
  })

  it('names the close match of an unknown long option', () => {
    expect(unknownOption('--jsn', [LEAF])).toBe(
      "error: unknown option '--jsn'\n(Did you mean --json?)\n",
    )
  })

  it('gives an unknown short option no suggestion', () => {
    expect(unknownOption('-j', [LEAF])).toBe("error: unknown option '-j'\n")
  })

  it('spells an option with its value shape', () => {
    expect(optionFlags(argumentAt(1))).toBe('--max-results <n>')
    expect(optionFlags(argumentAt(3))).toBe('-o, --output [file]')
    expect(optionFlags(argumentAt(4))).toBe('--json')
  })

  it('names an option left without its value as its help spells it', () => {
    expect(missingValue('--max-results', LEAF)).toBe(
      "error: option '--max-results <n>' argument missing\n",
    )
    expect(missingValue('--nope', LEAF)).toBeNull()
  })

  it('counts and lists stray operands', () => {
    expect(excessArguments(['frob', 'x'])).toBe(
      'error: too many arguments. Expected 0 arguments but got 2: frob, x.\n',
    )
    expect(excessArguments(['a'], 'auth')).toBe(
      "error: too many arguments for 'auth'. Expected 0 arguments but got 1: a.\n",
    )
  })
})
