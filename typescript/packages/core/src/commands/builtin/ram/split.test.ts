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
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_SPLIT = RAM_COMMANDS.filter((c) => c.name === 'split' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runSplit(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ exitCode: number }> {
  const cmd = RAM_SPLIT[0]
  if (cmd === undefined) throw new Error('split not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { exitCode: -1 }
  const [, ioResult] = result
  return { exitCode: ioResult.exitCode }
}

describe('split', () => {
  it('splits by lines with -l', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('a\nb\nc\nd\n'))
    const r = await runSplit(
      vfs,
      [PathSpec.fromStrPath('/f.txt'), PathSpec.fromStrPath('/chunk_')],
      { lines: '2' },
    )
    expect(r.exitCode).toBe(0)
    const aa = vfs.store.files.get('/chunk_aa')
    const ab = vfs.store.files.get('/chunk_ab')
    expect(aa).toBeDefined()
    expect(ab).toBeDefined()
    expect(DEC.decode(aa)).toBe('a\nb\n')
    expect(DEC.decode(ab)).toBe('c\nd\n')
  })

  it('splits by bytes with -b', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.bin', ENC.encode('ABCDEF'))
    const r = await runSplit(vfs, [PathSpec.fromStrPath('/f.bin'), PathSpec.fromStrPath('/p_')], {
      bytes: '2',
    })
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(vfs.store.files.get('/p_aa'))).toBe('AB')
    expect(DEC.decode(vfs.store.files.get('/p_ab'))).toBe('CD')
    expect(DEC.decode(vfs.store.files.get('/p_ac'))).toBe('EF')
  })

  it('-d uses numeric suffix', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('a\nb\nc\nd\n'))
    const r = await runSplit(vfs, [PathSpec.fromStrPath('/f.txt'), PathSpec.fromStrPath('/part')], {
      numeric_suffixes: true,
      l: '2',
    })
    expect(r.exitCode).toBe(0)
    expect(vfs.store.files.has('/part00')).toBe(true)
  })
})
