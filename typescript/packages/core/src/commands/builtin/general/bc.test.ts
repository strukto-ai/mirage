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
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_BC } from './bc.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runBc(
  stdin: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_BC[0]
  if (cmd === undefined) throw new Error('bc not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin: ENC.encode(stdin),
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('bc', () => {
  it('simple addition', async () => {
    expect(await runBc('2+3\n')).toEqual({ out: '5\n', exitCode: 0 })
  })

  it('multiple lines', async () => {
    expect(await runBc('1+1\n2*3\n')).toEqual({ out: '2\n6\n', exitCode: 0 })
  })

  it('operator precedence', async () => {
    expect(await runBc('2+3*4\n')).toEqual({ out: '14\n', exitCode: 0 })
  })

  it('parentheses', async () => {
    expect(await runBc('(2+3)*4\n')).toEqual({ out: '20\n', exitCode: 0 })
  })

  it('exponentiation with ^', async () => {
    expect(await runBc('2^10\n')).toEqual({ out: '1024\n', exitCode: 0 })
  })

  it('right-associative ^', async () => {
    // 2^3^2 = 2^9 = 512
    expect(await runBc('2^3^2\n')).toEqual({ out: '512\n', exitCode: 0 })
  })

  it('floats', async () => {
    expect(await runBc('1.5*2\n')).toEqual({ out: '3\n', exitCode: 0 })
  })

  it('negative unary', async () => {
    expect(await runBc('-5+10\n')).toEqual({ out: '5\n', exitCode: 0 })
  })

  it('modulus', async () => {
    expect(await runBc('10%3\n')).toEqual({ out: '1\n', exitCode: 0 })
  })

  it('-l enables math functions', async () => {
    const r = await runBc('sqrt(16)\n', { args_l: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('4')
  })

  it('-l enables sin', async () => {
    const r = await runBc('s(0)\n', { args_l: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('0')
  })

  it('identifier without -l errors', async () => {
    const r = await runBc('sqrt(4)\n')
    expect(r.exitCode).toBe(1)
  })

  it('skips blank lines', async () => {
    expect(await runBc('1+1\n\n2+2\n')).toEqual({ out: '2\n4\n', exitCode: 0 })
  })
})
