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
import { MountMode, PathSpec } from '../../../types.ts'
import { OpsRegistry } from '../../../ops/registry.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
const RAM_XXD = RAM_COMMANDS.filter((c) => c.name === 'xxd' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runXxd(
  vfs: RAMVFS,
  paths: PathSpec[],
  flags: Record<string, string | boolean | number | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; outBytes: Uint8Array; exitCode: number }> {
  const cmd = RAM_XXD[0]
  if (cmd === undefined) throw new Error('xxd not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', outBytes: new Uint8Array(), exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), outBytes: buf, exitCode: ioResult.exitCode }
}

describe('xxd', () => {
  it('-p plain hex', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/f.txt', ENC.encode('AB'))
    const r = await runXxd(vfs, [PathSpec.fromStrPath('/f.txt')], { p: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('4142')
  })

  it('-r -p reverse hex from stdin', async () => {
    const vfs = new RAMVFS()
    const r = await runXxd(vfs, [], { r: true, p: true }, ENC.encode('4142'))
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(r.outBytes)).toBe('AB')
  })

  it('replaces OUTFILE with the dump', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/in', ENC.encode('hi\n'))
    vfs.store.files.set('/out', ENC.encode('old old old\n'))
    const r = await runXxd(vfs, [PathSpec.fromStrPath('/in'), PathSpec.fromStrPath('/out')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
    expect(DEC.decode(vfs.store.files.get('/out'))).toBe(
      '00000000: 6869 0a                                  hi.\n',
    )
  })

  it('-r writes into OUTFILE at its offsets', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/out', ENC.encode('ABCDEFGH'))
    const paths = [PathSpec.fromStrPath('-'), PathSpec.fromStrPath('/out')]
    const r = await runXxd(vfs, paths, { r: true }, ENC.encode('00000004: 6869  hi\n'))
    expect(r.exitCode).toBe(0)
    expect(DEC.decode(vfs.store.files.get('/out'))).toBe('ABCDhiGH')
  })

  it('-r on a stream fills forward and refuses a backward seek', async () => {
    const vfs = new RAMVFS()
    const dump = ENC.encode('00000002: 6869  hi\n00000000: 4142  AB\n')
    const r = await runXxd(vfs, [], { r: true }, dump)
    expect([...r.outBytes]).toEqual([0, 0, 0x68, 0x69])
    expect(r.exitCode).toBe(5)
  })

  it('-u uppercase', async () => {
    const vfs = new RAMVFS()
    const r = await runXxd(vfs, [], { u: true }, new Uint8Array([0xab, 0xcd]))
    expect(r.exitCode).toBe(0)
    const text = r.out
    expect(text.includes('AB') || text.includes('CD')).toBe(true)
  })
})

describe('xxd -r into its own input', () => {
  it('reads back patched on a caching mount', async () => {
    // INFILE is OUTFILE on a caching mount: the cache must not keep the
    // write's marker as the file, so the next read sees the store. Mirrors
    // Python's test_xxd_reverse_into_its_own_input_reads_back_patched.
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      await ws.shell("printf '00000000: 4142  AB\\n' > /data/d")
      await ws.shell('cat /data/d')
      const result = await ws.shell('xxd -r /data/d /data/d')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('cat /data/d')).stdout)).toBe('AB000000: 4142  AB\n')
    } finally {
      await ws.close()
    }
  })
})

describe('xxd -r across mounts', () => {
  it('writes into the stored bytes of a rendered OUTFILE', async () => {
    // The OUTFILE's mount renders .tally reads; -r writes into what the
    // store holds, never into a rendering of it. Mirrors Python's
    // test_xxd_reverse_across_mounts_writes_into_the_stored_bytes.
    const source = new RAMVFS()
    const target = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(source)
    registry.registerVfs(target)
    registry.register({
      name: 'read',
      vfs: 'ram',
      filetype: '.tally',
      write: false,
      fn: () => Promise.resolve(ENC.encode('RENDERED')),
    })
    const ws = new Workspace(
      { '/a': source, '/b': target },
      { mode: MountMode.WRITE, ops: registry, shellParser: await getTestParser() },
    )
    try {
      await ws.shell('printf ABCDEFGH > /b/out.tally')
      await ws.shell("printf '00000004: 6869  hi\\n' > /a/dump")
      const result = await ws.shell('xxd -r /a/dump /b/out.tally')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(target.store.files.get('/out.tally'))).toBe('ABCDhiGH')
    } finally {
      await ws.close()
    }
  })
})
