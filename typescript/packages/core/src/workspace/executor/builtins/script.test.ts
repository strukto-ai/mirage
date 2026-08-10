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
import { materialize } from '../../../io/types.ts'
import { parseBashArgs } from './script.ts'

const DEC = new TextDecoder()

describe('parseBashArgs', () => {
  it('ends option parsing at a script file operand', () => {
    const parsed = parseBashArgs('sh', ['run.sh', '-x', 'a'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.argv).toEqual(['-x', 'a'])
    expect(parsed.options).toEqual([])
  })

  it('takes a flag-shaped file after --', () => {
    const parsed = parseBashArgs('sh', ['--', '-weird.sh', 'a'])
    expect(parsed.path).toBe('-weird.sh')
    expect(parsed.argv).toEqual(['a'])
  })

  it('keeps set options from a cluster ending in c', () => {
    const parsed = parseBashArgs('bash', ['-xc', 'echo hi', 'name', 'a'])
    expect(parsed.script).toBe('echo hi')
    expect(parsed.argv).toEqual(['name', 'a'])
    expect(parsed.options).toEqual(['xtrace'])
  })

  it('maps set flags to shell options', () => {
    const parsed = parseBashArgs('bash', ['-eux', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
    expect(parsed.options).toEqual(['errexit', 'nounset', 'xtrace'])
  })

  it('reads the program from stdin under -s', () => {
    const parsed = parseBashArgs('bash', ['-s'])
    expect(parsed.readStdin).toBe(true)
    expect(parsed.path).toBeNull()
    expect(parsed.script).toBeNull()
  })

  it('skips -o and its value', () => {
    const parsed = parseBashArgs('bash', ['-o', 'pipefail', 'run.sh'])
    expect(parsed.path).toBe('run.sh')
  })

  it('reports an unsupported option as a usage error', async () => {
    const parsed = parseBashArgs('sh', ['-Z'])
    if (parsed.error === null) throw new Error('expected a usage error')
    const [, io] = parsed.error
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(await materialize(io.stderr))).toBe('sh: -Z: unsupported option\n')
  })
})
