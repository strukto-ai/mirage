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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_SORT = RAM_COMMANDS.filter((c) => c.name === 'sort' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runSort(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_SORT[0]
  if (cmd === undefined) throw new Error('sort not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { lines: [], exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = stripped === '' ? [] : stripped.split('\n')
  return { lines, exitCode: ioResult.exitCode }
}

describe('sort', () => {
  // One row per ordering the RAM wiring hands the generic; integ pins each
  // one byte for byte (unix/sort).
  it.each([
    ['banana\napple\ncherry', {}, ['apple', 'banana', 'cherry']],
    ['banana\napple\ncherry', { reverse: true }, ['cherry', 'banana', 'apple']],
    ['10\n2\n30\n1', { numeric_sort: true }, ['1', '2', '10', '30']],
    ['banana\napple\nbanana\napple\ncherry', { unique: true }, ['apple', 'banana', 'cherry']],
    ['Banana\napple\nCherry', { ignore_case: true }, ['apple', 'Banana', 'Cherry']],
    [
      'a:10\nb:2\nc:30',
      { field_separator: ':', key: '2', numeric_sort: true },
      ['b:2', 'a:10', 'c:30'],
    ],
    ['a 2 z\nb 2 a\nc 1 m\n', { key: ['2,2n', '1,1r'] }, ['c 1 m', 'b 2 a', 'a 2 z']],
    [
      'apple:12\nbee:3\ncat:100\n',
      { field_separator: ':', key: '1.2,1.3' },
      ['cat:100', 'bee:3', 'apple:12'],
    ],
    ['z 2\nm 2\na 2\n', { stable: true, key: '2,2n' }, ['z 2', 'm 2', 'a 2']],
    ['inf\n5\n-3\nnan\nabc', { general_numeric_sort: true }, ['abc', 'nan', '-3', '5', 'inf']],
    [
      '0x10\n5\n12abc\n0x\n0x1p99999',
      { general_numeric_sort: true },
      ['0x', '5', '12abc', '0x10', '0x1p99999'],
    ],
  ] as const)('sorts %j under %j', async (text, flags, want) => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/f.txt', ENC.encode(text))
    const r = await runSort(vfs, [PathSpec.fromStrPath('/tmp/f.txt')], { ...flags } as never)
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual(want)
  })

  it('missing stdin and no path uses empty standard input', async () => {
    const vfs = new RAMVFS()
    const r = await runSort(vfs, [])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual([])
  })

  it('zero field number exits 2', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/f.txt', ENC.encode('a\nb\n'))
    const r = await runSort(vfs, [PathSpec.fromStrPath('/tmp/f.txt')], { key: '0' })
    expect(r.exitCode).toBe(2)
    expect(r.lines).toEqual([])
  })
})
