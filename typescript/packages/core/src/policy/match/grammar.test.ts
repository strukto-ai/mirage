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
import { SPECS } from '../../commands/spec/index.ts'
import { parseCommand } from '../../commands/spec/parser.ts'
import { leafRead } from './grammar.ts'

function spec(name: string) {
  const found = SPECS[name]
  if (found === undefined) throw new Error(`no spec ${name}`)
  return found
}

describe('leafRead', () => {
  it('holds each option by its canonical name', () => {
    for (const argv of [
      ['-rf', 'x'],
      ['-r', '-f', 'x'],
      ['--recursive', '--force', 'x'],
    ]) {
      const read = leafRead(['rm'], parseCommand(spec('rm'), argv, '/', 'rm'))
      expect(read.flags).toEqual([
        { name: '--recursive', values: [] },
        { name: '--force', values: [] },
      ])
      expect(read.operands).toEqual(['x'])
    }
  })

  it("keeps an option's value", () => {
    const read = leafRead(['head'], parseCommand(spec('head'), ['-n', '2'], '/', 'head'))
    expect(read.flags).toEqual([{ name: '--lines', values: ['2'] }])
  })

  it('keeps what the grammar read of a line it refuses', () => {
    const read = (name: string, argv: string[]) =>
      leafRead([name], parseCommand(spec(name), argv, '/', name))
    const bogus = read('rm', ['--bogus', '-r', 'x'])
    expect(bogus.flags).toEqual([
      { name: '--recursive', values: [] },
      { name: '--bogus', values: [] },
    ])
    expect(bogus.operands).toEqual(['x'])
    const found = read('find', ['/d', '-type', 'f', '-delete', '-exec', 'echo', ';'])
    expect(found.flags).toEqual([
      { name: '-type', values: ['f'] },
      { name: '-delete', values: [] },
      { name: '-e', values: [] },
    ])
    expect(found.operands).toEqual(['/d', 'echo', ';'])
    expect(read('rm', ['--force=1', 'x']).flags).toEqual([{ name: '--force', values: [] }])
    expect(read('cp', ['-Q', 'a', 'b']).flags).toEqual([{ name: '-Q', values: [] }])
    expect(read('grep', ['--c', 'x']).flags).toEqual([{ name: '--c', values: [] }])
  })
})
