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
import { parseBashArgs } from './script.ts'

describe('parseBashArgs', () => {
  it('ends option parsing at a script file operand', () => {
    const parsed = parseBashArgs(['run.sh', '-x', 'a'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.argv).toEqual(['-x', 'a'])
    expect(parsed.settings).toEqual([])
  })

  it('takes a flag-shaped file after --', () => {
    const parsed = parseBashArgs(['--', '-weird.sh', 'a'])
    expect(parsed.path).toBe('-weird.sh')
    expect(parsed.argv).toEqual(['a'])
  })

  it('ends option parsing at a single dash', () => {
    expect(parseBashArgs(['-', 'run.sh']).path).toBe('run.sh')
  })

  it('keeps set options from a cluster ending in c', () => {
    const parsed = parseBashArgs(['-xc', 'echo hi', 'name', 'a'])
    expect(parsed.script).toBe('echo hi')
    expect(parsed.argv).toEqual(['name', 'a'])
    expect(parsed.settings).toEqual([['xtrace', true]])
  })

  it('maps set flags to shell options', () => {
    const parsed = parseBashArgs(['-eux', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.settings).toEqual([
      ['errexit', true],
      ['nounset', true],
      ['xtrace', true],
    ])
  })

  it('lets the last sign win within one invocation', () => {
    const parsed = parseBashArgs(['-e', '+e', 'run.sh'])
    expect(parsed.settings).toEqual([
      ['errexit', true],
      ['errexit', false],
    ])
  })

  it('keeps every operand positional under -s', () => {
    const parsed = parseBashArgs(['-s', 'A', 'B'])
    expect(parsed.path).toBeNull()
    expect(parsed.script).toBeNull()
    expect(parsed.argv).toEqual(['A', 'B'])
  })

  it('applies -o and its value', () => {
    const parsed = parseBashArgs(['-o', 'pipefail', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.settings).toEqual([['pipefail', true]])
  })

  it('consumes a long option value', () => {
    expect(parseBashArgs(['--rcfile', 'rc', 'run.sh']).path).toBe('run.sh')
  })

  it('reports an unsupported short option', () => {
    expect(parseBashArgs(['-Z']).invalid).toBe('-Z')
  })

  it('reports an unsupported long option', () => {
    expect(parseBashArgs(['--nosuch', 'run.sh']).invalid).toBe('--nosuch')
  })

  it('reports -c with no value', () => {
    expect(parseBashArgs(['-c']).needsValue).toBe('-c')
  })
})
