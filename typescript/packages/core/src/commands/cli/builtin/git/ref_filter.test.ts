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

import { GIT } from './index.ts'
import { filterWords, listModeOption, withoutFilterValues } from './ref_filter.ts'
import { cliInvocation } from '../../../../workspace/fixtures/cli_invocation.ts'

function words(verb: string, argv: string[]): ReturnType<typeof filterWords> {
  const spec = GIT.subcommands.find((node) => node.name === verb)
  const inv = cliInvocation({
    config: null,
    argv: [verb, ...argv],
    ...(spec === undefined ? {} : { spec }),
  })
  return filterWords(inv)
}

describe('filterWords', () => {
  // parse-options' LASTARG_DEFAULT: the next word, whatever it looks like,
  // or HEAD when the option is the last word on the line.
  it('takes the next word as the commit, or HEAD as the last word', () => {
    expect(words('branch', ['--merged', 'main', '--contains'])).toEqual([
      { option: '--merged', value: 'main', operand: true },
      { option: '--contains', value: 'HEAD', operand: false },
    ])
  })

  it('takes a dash word too, which the parser read as an option', () => {
    expect(words('branch', ['--merged', '--no-merged'])).toEqual([
      { option: '--merged', value: '--no-merged', operand: false },
    ])
  })

  it('reads an attached value and a unique prefix', () => {
    expect(words('branch', ['--cont=side', '--no-merged', 'x'])).toEqual([
      { option: '--contains', value: 'side', operand: false },
      { option: '--no-merged', value: 'x', operand: true },
    ])
  })

  it("leaves another option's value alone, even one spelling a filter", () => {
    expect(words('tag', ['-a', '-m', '--contains', 'v1'])).toEqual([])
    expect(words('tag', ['-m--contains', '--merged', 'v1'])).toEqual([
      { option: '--merged', value: 'v1', operand: true },
    ])
  })

  it('stops at --, where the parser stops', () => {
    expect(words('branch', ['--', '--contains', 'x'])).toEqual([])
  })

  it('takes --points-at as a value option the parser already consumed', () => {
    expect(words('tag', ['--points-at', 'HEAD'])).toEqual([
      { option: '--points-at', value: 'HEAD', operand: false },
    ])
  })
})

describe('withoutFilterValues', () => {
  it('drops the values the parser left among the operands, once each', () => {
    const found = words('branch', ['--contains', 'side', 'side', 'x*'])
    expect(withoutFilterValues(['side', 'side', 'x*'], found)).toEqual(['side', 'x*'])
  })
})

describe('listModeOption', () => {
  it("names the filter git refuses first, in git's order", () => {
    expect(listModeOption(words('tag', ['--merged', 'a', '--contains', 'b']))).toBe('--contains')
    expect(listModeOption([])).toBeNull()
  })
})
