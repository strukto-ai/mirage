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
import { GENERAL_SEQ } from './seq.ts'

const DEC = new TextDecoder()

async function runSeq(
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const resource = new RAMResource()
  const cmd = GENERAL_SEQ[0]
  if (cmd === undefined) throw new Error('seq not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('seq', () => {
  it('single arg: 1..N', async () => {
    expect(await runSeq(['5'])).toBe('1\n2\n3\n4\n5\n')
  })

  it('two args: first..last', async () => {
    expect(await runSeq(['3', '6'])).toBe('3\n4\n5\n6\n')
  })

  it('three args: first,step,last', async () => {
    expect(await runSeq(['2', '2', '10'])).toBe('2\n4\n6\n8\n10\n')
  })

  it('negative step', async () => {
    expect(await runSeq(['10', '-2', '4'])).toBe('10\n8\n6\n4\n')
  })

  it('custom separator -s', async () => {
    expect(await runSeq(['3'], { s: ', ' })).toBe('1, 2, 3\n')
  })

  it('width -w pads with zeros', async () => {
    expect(await runSeq(['8', '10'], { w: true })).toBe('08\n09\n10\n')
  })

  it('format -f', async () => {
    expect(await runSeq(['3'], { f: '%03d' })).toBe('001\n002\n003\n')
  })
})
