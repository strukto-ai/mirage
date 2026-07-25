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

import { RAM_COMMANDS } from '../index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
const RAM_CUT = RAM_COMMANDS.filter((c) => c.name === 'cut' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runCut(
  stdin: Uint8Array | null,
  flags: Record<string, string | boolean | string[]>,
): Promise<string> {
  const resource = new RAMResource()
  const cmd = RAM_CUT[0]
  if (cmd === undefined) throw new Error('cut not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('cut', () => {
  it('-f with default tab', async () => {
    expect(await runCut(ENC.encode('a\tb\tc\n'), { f: '2' })).toBe('b\n')
  })

  it('-f -d :', async () => {
    expect(await runCut(ENC.encode('a:b:c\nd:e:f\n'), { f: '1', d: ':' })).toBe('a\nd\n')
  })

  it('-c byte range', async () => {
    expect(await runCut(ENC.encode('hello world\n'), { c: '1-5' })).toBe('hello\n')
  })

  it('-f with complement', async () => {
    expect(await runCut(ENC.encode('a:b:c:d\n'), { d: ':', f: '2', complement: true })).toBe(
      'a:c:d\n',
    )
  })

  it('-f,-f picks multiple fields', async () => {
    expect(await runCut(ENC.encode('a,b,c,d\n'), { d: ',', f: '1,3' })).toBe('a,c\n')
  })

  it('-f with range', async () => {
    expect(await runCut(ENC.encode('a,b,c,d,e\n'), { d: ',', f: '2-4' })).toBe('b,c,d\n')
  })

  it('-z zero-terminated', async () => {
    expect(await runCut(ENC.encode('a:b\x00c:d\x00'), { d: ':', f: '1', z: true })).toBe(
      'a\x00c\x00',
    )
  })

  it('-f reorders to file order, not spec order', async () => {
    expect(await runCut(ENC.encode('a\tb\tc\n'), { f: '3,1' })).toBe('a\tc\n')
  })

  it('-f open range to end of line', async () => {
    expect(await runCut(ENC.encode('a\tb\tc\td\n'), { f: '2-' })).toBe('b\tc\td\n')
  })

  it('-f line without delimiter passes through whole', async () => {
    expect(await runCut(ENC.encode('nodelim\na\tb\n'), { f: '2' })).toBe('nodelim\nb\n')
  })

  it('-w handles long whitespace runs', async () => {
    const whitespace = '\t'.repeat(50_000)
    expect(await runCut(ENC.encode(`a${whitespace}b\n`), { f: '2', w: true })).toBe('b\n')
  })

  it('--whitespace-delimited=trimmed removes edge whitespace', async () => {
    expect(
      await runCut(ENC.encode('  a   b c  \n'), {
        f: '1,3',
        whitespace_delimited: 'trimmed',
      }),
    ).toBe('a\tc\n')
  })

  it('-c overlapping ranges dedup ascending', async () => {
    expect(await runCut(ENC.encode('abcdef\n'), { c: '1-3,2-4' })).toBe('abcd\n')
  })

  it('-c open range to end of line', async () => {
    expect(await runCut(ENC.encode('abcdef\n'), { c: '3-' })).toBe('cdef\n')
  })

  it('missing stdin returns error', async () => {
    const resource = new RAMResource()
    const cmd = RAM_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
      stdin: null,
      flags: { f: '1' },
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('result null')
    const [, ioResult] = result
    expect(ioResult.exitCode).toBe(1)
    const stderr = ioResult.stderr
    const errBytes =
      stderr === null
        ? new Uint8Array()
        : stderr instanceof Uint8Array
          ? stderr
          : await materialize(stderr)
    expect(DEC.decode(errBytes)).toMatch(/missing operand/)
  })

  it('multi-character delimiter is rejected', async () => {
    const resource = new RAMResource()
    const cmd = RAM_CUT[0]
    if (cmd === undefined) throw new Error('cut not registered')
    const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
      stdin: ENC.encode('a,b\n'),
      flags: { f: '1', d: ',,' },
      filetypeFns: null,
      cwd: '/',
      resource,
    })
    if (result === null) throw new Error('result null')
    const [out, ioResult] = result
    expect(out).toBeNull()
    expect(ioResult.exitCode).toBe(1)
    const stderr = ioResult.stderr
    const errBytes =
      stderr === null
        ? new Uint8Array()
        : stderr instanceof Uint8Array
          ? stderr
          : await materialize(stderr)
    expect(DEC.decode(errBytes)).toMatch(/delimiter must be a single character/)
  })
})
