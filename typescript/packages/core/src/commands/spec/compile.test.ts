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
import { compileSpec } from './compile.ts'
import { CommandSpec, OperandKind, Option } from './types.ts'

describe('compileSpec — count/choices/required/default tables', () => {
  it('collects the new tables keyed by canonical spelling', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ short: '-v', long: '--verbose', count: true }),
        new Option({
          long: '--mode',
          valueKind: OperandKind.TEXT,
          choices: ['a', 'b'],
          default: 'a',
        }),
        new Option({ long: '--out', valueKind: OperandKind.TEXT, required: true }),
      ],
    })
    const cs = compileSpec(spec)
    expect(cs.countDests).toEqual(new Set(['--verbose']))
    expect(cs.choicesByDest).toEqual(new Map([['--mode', ['a', 'b']]]))
    expect(cs.requiredDests).toEqual(['--out'])
    expect(cs.defaults).toEqual(new Map([['--mode', 'a']]))
  })

  it('rejects count on a value flag', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--level', valueKind: OperandKind.TEXT, count: true })],
    })
    expect(() => compileSpec(spec)).toThrow(/count requires a boolean flag/)
  })

  it('rejects choices or default on a boolean flag', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--quiet', choices: ['a', 'b'] })],
    })
    expect(() => compileSpec(spec)).toThrow(/require a value flag/)
  })

  it('rejects a default outside the choices set', () => {
    const spec = new CommandSpec({
      options: [
        new Option({
          long: '--mode',
          valueKind: OperandKind.TEXT,
          choices: ['a', 'b'],
          default: 'c',
        }),
      ],
    })
    expect(() => compileSpec(spec)).toThrow(/not one of its choices/)
  })

  it('caches per spec object', () => {
    const spec = new CommandSpec({ options: [new Option({ short: '-x' })] })
    expect(compileSpec(spec)).toBe(compileSpec(spec))
  })
})
