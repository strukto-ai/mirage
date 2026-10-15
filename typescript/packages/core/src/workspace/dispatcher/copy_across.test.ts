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
import { Limit, MountMode, type PathSpec, WritePolicy } from '../../types.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { Handed } from '../../vfs/types.ts'
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
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    this.reads.push(path.virtual)
    return super.read(path, handed, offset, size)
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

/** A source whose reads the file cache keeps. */
class CachedStoreRAM extends StoreRAM {
  override readonly cachesReads = true
}

/** A destination whose store copy outlasts any deadline. */
class SlowStoreRAM extends StoreRAM {
  override async copyFrom(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

describe('a copy a read would answer otherwise', () => {
  // Mirrors python's test_a_cached_source_moves_the_bytes_a_read_gives.
  it('moves the bytes of a cached source', async () => {
    const b = new StoreRAM()
    const ws = await seeded(new CachedStoreRAM(), b)
    await ws.shell('cat /a/f')
    const io = await ws.shell('cp /a/f /b/g')
    expect(io.exitCode).toBe(0)
    expect(b.copied).toEqual([])
    expect(stdoutStr(await ws.shell('cat /b/g'))).toBe('payload\n')
  })

  // Mirrors python's test_a_pinned_source_moves_the_bytes.
  it('moves the bytes of a pinned source', async () => {
    const b = new StoreRAM()
    const ws = await seeded(new StoreRAM(), b)
    ws.registry.mountFor('/a/f').revisions.set('/a/f', 'v1')
    const io = await ws.shell('cp /a/f /b/g')
    expect(io.exitCode).toBe(0)
    expect(b.copied).toEqual([])
  })

  // Mirrors python's test_a_conditional_mount_moves_the_bytes.
  it.each(['/a/f', '/b/g'])('moves the bytes with %s on a conditional mount', async (path) => {
    const b = new StoreRAM()
    const ws = await seeded(new StoreRAM(), b)
    ;(ws.registry.mountFor(path) as { write: string }).write = WritePolicy.CONDITIONAL
    await ws.shell('mv /a/f /b/g')
    expect(b.copied).toEqual([])
  })

  // Mirrors python's test_a_store_copy_keeps_the_copy_timeout.
  it('keeps the copy timeout', async () => {
    const ws = await seeded(new StoreRAM(), new SlowStoreRAM())
    ws.registry.mountFor('/b/g').commandLimits.set('copy', new Limit({ timeoutSeconds: 0.05 }))
    const io = await ws.shell('cp /a/f /b/g')
    expect(io.exitCode).not.toBe(0)
  })

  // Mirrors python's test_a_rendered_source_moves_the_bytes_a_read_gives.
  it('moves the bytes of a rendered source', async () => {
    const a = new StoreRAM()
    const b = new StoreRAM()
    const ws = await seeded(a, b)
    ;(a as { renderers: Record<string, string> }).renderers = { '.txt': 'read' }
    await ws.shell("printf 'payload\\n' > /a/f.txt")
    const io = await ws.shell('cp /a/f.txt /b/g')
    expect(io.exitCode).toBe(0)
    expect(b.copied).toEqual([])
  })
})
