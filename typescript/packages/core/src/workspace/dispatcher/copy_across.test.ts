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

// Mirrors python/tests/workspace/dispatcher/test_copy_across.py.

import { describe, expect, it } from 'vitest'

import { exdev } from '../../errors/fs.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Mount } from '../mount/spec.ts'
import { Workspace } from '../workspace/workspace.ts'

/** A RAM store that copies from another of its kind, store to store. */
class StoreRAM extends RAMVFS {
  readonly copied: [string, string][] = []
  readonly reads: string[] = []

  constructor(readonly refuse = false) {
    super()
  }

  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    this.reads.push(path.virtual)
    return super.read(path, index, offset, size)
  }

  override async copyFrom(source: BaseVFS, src: PathSpec, dst: PathSpec): Promise<void> {
    if (this.refuse || !(source instanceof StoreRAM)) throw exdev(dst)
    this.copied.push([src.vfsPath, dst.vfsPath])
    const data = source.store.files.get(`/${src.vfsPath}`)
    if (data === undefined) throw exdev(dst)
    await this.write(dst, data)
  }
}

async function seeded(
  a: StoreRAM,
  b: RAMVFS,
  mode: MountMode = MountMode.WRITE,
): Promise<Workspace> {
  const ws = new Workspace(
    { '/a': a, '/b': new Mount(b, { mode }) },
    {
      mode: MountMode.WRITE,
      shellParser: await getTestParser(),
      profiles: { hiding: parseSessionProfile({ paths: { hide: ['/b/g'] } }) },
    },
  )
  const io = await ws.shell("printf 'payload\\n' > /a/f")
  expect(io.exitCode).toBe(0)
  a.reads.length = 0
  return ws
}

describe('a copy between two stores', () => {
  it.each(['cp /a/f /b/g', 'mv /a/f /b/g'])('moves no bytes: %s', async (line) => {
    const a = new StoreRAM()
    const b = new StoreRAM()
    const ws = await seeded(a, b)
    const io = await ws.shell(line)
    expect(io.exitCode).toBe(0)
    expect(b.copied).toEqual([['f', 'g']])
    expect(a.reads).toEqual([])
    expect(stdoutStr(await ws.shell('cat /b/g'))).toBe('payload\n')
  })

  it.each([
    ['a refusing store', new StoreRAM(true)],
    ['a store that cannot copy', new RAMVFS()],
  ])('moves the bytes to %s', async (_label, b) => {
    const a = new StoreRAM()
    const ws = await seeded(a, b)
    const io = await ws.shell('cp /a/f /b/g')
    expect(io.exitCode).toBe(0)
    expect(a.reads).toEqual(['/a/f'])
    expect(stdoutStr(await ws.shell('cat /b/g'))).toBe('payload\n')
  })

  it('is refused on a read-only destination', async () => {
    const a = new StoreRAM()
    const b = new StoreRAM()
    const ws = await seeded(a, b, MountMode.READ)
    const io = await ws.shell('cp /a/f /b/g')
    expect(io.exitCode).toBe(1)
    expect(b.copied).toEqual([])
  })

  it('is refused on a hidden destination', async () => {
    const a = new StoreRAM()
    const b = new StoreRAM()
    const ws = await seeded(a, b)
    const session = ws.createSession('s', { profile: 'hiding' })
    const io = await ws.shell('cp /a/f /b/g', { sessionId: session.sessionId })
    expect(io.exitCode).toBe(1)
    expect(b.copied).toEqual([])
  })
})
