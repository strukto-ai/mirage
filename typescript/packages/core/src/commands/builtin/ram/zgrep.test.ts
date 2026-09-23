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
import { gzip } from '../../../utils/compress.ts'
const RAM_ZGREP = RAM_COMMANDS.filter((c) => c.name === 'zgrep' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runZgrep(
  vfs: RAMVFS,
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_ZGREP[0]
  if (cmd === undefined) throw new Error('zgrep not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, texts, {
    stdin,
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

describe('zgrep', () => {
  it('finds pattern in gzipped file', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\nbaz\n'))
    vfs.store.files.set('/f.gz', compressed)
    const r = await runZgrep(vfs, [PathSpec.fromStrPath('/f.gz')], ['bar'])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('bar')
  })

  it('exits with 1 when no match', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\n'))
    vfs.store.files.set('/f.gz', compressed)
    const r = await runZgrep(vfs, [PathSpec.fromStrPath('/f.gz')], ['xyz'])
    expect(r.exitCode).toBe(1)
  })

  it('-L prints the operand as typed', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/o.gz', await gzip(ENC.encode('foo\n')))
    const typed = new PathSpec({
      virtual: '/o.gz',
      directory: '/',
      vfsPath: '/o.gz',
      rawPath: './o.gz',
    })
    const r = await runZgrep(vfs, [typed], ['hello'], { files_without_match: true })
    expect(r.exitCode).toBe(1)
    expect(r.out).toBe('./o.gz\n')
    const listed = await runZgrep(vfs, [typed], ['foo'], { args_l: true })
    expect(listed.out).toBe('./o.gz\n')
  })

  it('labels stdin "(standard input)" under -H', async () => {
    const vfs = new RAMVFS()
    const compressed = await gzip(ENC.encode('foo\nbar\n'))
    const r = await runZgrep(vfs, [], ['bar'], { H: true }, compressed)
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('(standard input):bar\n')
  })
})
