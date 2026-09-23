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
const RAM_DU = RAM_COMMANDS.filter((c) => c.name === 'du' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runDu(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_DU[0]
  if (cmd === undefined) throw new Error('du not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
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
  const lines = text === '' ? [] : text.trimEnd().split('\n')
  return { lines, exitCode: ioResult.exitCode }
}

describe('du', () => {
  it('single file returns its size', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/f.txt', ENC.encode('hello'))
    const r = await runDu(vfs, [PathSpec.fromStrPath('/tmp/f.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual(['5\t/tmp/f.txt'])
  })

  it('directory recursive sum', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.dirs.add('/tmp/sub')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('aaa'))
    vfs.store.files.set('/tmp/sub/b.txt', ENC.encode('bb'))
    const r = await runDu(vfs, [PathSpec.fromStrPath('/tmp')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toEqual(['2\t/tmp/sub', '5\t/tmp'])
  })

  it('reports a missing path and exits 1, like GNU', async () => {
    const vfs = new RAMVFS()
    const r = await runDu(vfs, [PathSpec.fromStrPath('/nonexistent')])
    expect(r.lines).toEqual([])
    expect(r.exitCode).toBe(1)
  })

  it('empty directory returns 0', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    const r = await runDu(vfs, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toEqual(['0\t/tmp'])
  })

  it('-h human-readable size', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/big.txt', ENC.encode('x'.repeat(2048)))
    const r = await runDu(vfs, [PathSpec.fromStrPath('/tmp')], { h: true })
    expect(r.lines[0]).toMatch(/^2(\.\d+)?K\t\/tmp$/)
  })

  it('handles multiple paths', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/a.txt', ENC.encode('a'))
    vfs.store.files.set('/b.txt', ENC.encode('bb'))
    const r = await runDu(vfs, [PathSpec.fromStrPath('/a.txt'), PathSpec.fromStrPath('/b.txt')])
    expect(r.lines).toEqual(['1\t/a.txt', '2\t/b.txt'])
  })

  it('-a lists each file plus the directory total', async () => {
    const vfs = new RAMVFS()
    vfs.store.dirs.add('/tmp')
    vfs.store.files.set('/tmp/a.txt', ENC.encode('a'))
    vfs.store.files.set('/tmp/b.txt', ENC.encode('bb'))
    const r = await runDu(vfs, [PathSpec.fromStrPath('/tmp')], { a: true })
    expect(r.lines).toContain('1\t/tmp/a.txt')
    expect(r.lines).toContain('2\t/tmp/b.txt')
    expect(r.lines[r.lines.length - 1]).toBe('3\t/tmp')
  })
})
