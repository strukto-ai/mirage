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
import { PathSpec } from '../../types.ts'
import { Argv } from './argv.ts'

function ps(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1),
    resourcePath: '',
    resolved: true,
  })
}

describe('Argv', () => {
  it('words includes the name', () => {
    const spec = ps('/ram/f.txt')
    const argv = new Argv('cat', ['f.txt'], [spec])
    expect(argv.words).toEqual(['cat', spec])
  })

  it('words is empty for an empty command', () => {
    expect(new Argv('', [], []).words).toEqual([])
  })

  it('views differ only in type', () => {
    const pattern = ps('/ram/*.txt')
    const argv = new Argv('ls', ['/ram/*.txt'], [pattern])
    expect(argv.args).toHaveLength(argv.operands.length)
    expect(argv.args[0]).toBe((argv.operands[0] as PathSpec).virtual)
  })

  it('withOperands replaces only operands', () => {
    const link = ps('/ram/link')
    const target = ps('/ram/target')
    const argv = new Argv('rm', ['link'], [link])
    const rewritten = argv.withOperands([target])
    expect(rewritten.operands).toEqual([target])
    expect(rewritten.name).toBe('rm')
    expect(rewritten.args).toEqual(['link'])
    expect(argv.operands).toEqual([link])
  })

  it('is frozen', () => {
    const argv = new Argv('cat', [], [])
    expect(() => {
      ;(argv as { name: string }).name = 'dog'
    }).toThrow()
  })
})
