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

import { beforeEach, describe, expect, it } from 'vitest'
import type { Ops } from '../../ops/ops.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { FileVersionTracker, StaleMirageFileError, fingerprint } from './file_version.ts'

let ws: Workspace

beforeEach(async () => {
  ws = new Workspace(
    { '/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
})

// A read seam that answers with something other than the stored bytes.
// Any mount carrying a filetype read op behaves this way: writeFile
// stores one thing and readFile hands back the rendering. The tracker
// reaches the workspace only through these calls, so this is the whole
// of the condition.
function renderingVfs(inner: Workspace): Ops {
  const prefix = new TextEncoder().encode('rendered:')
  return {
    links: inner.vfs.links,
    read: async (path: string): Promise<Uint8Array> => {
      const stored = await inner.vfs.read(path, { raw: true })
      return new Uint8Array([...prefix, ...stored])
    },
    write: (path: string, content: string | Uint8Array): Promise<void> =>
      inner.vfs.write(path, content),
    exists: (path: string): Promise<boolean> => inner.vfs.exists(path),
  } as unknown as Ops
}

// A read seam that holds the reads at the given call indices once they
// fetched their bytes, until the test releases them, so a write can land
// while a read is in flight.
function heldVfs(
  inner: Workspace,
  holdAt: readonly number[],
): {
  vfs: Ops
  fetched: Map<number, Promise<void>>
  release: Map<number, () => void>
} {
  const fetched = new Map<number, Promise<void>>()
  const reached = new Map<number, () => void>()
  const release = new Map<number, () => void>()
  const held = new Map<number, Promise<void>>()
  for (const n of holdAt) {
    fetched.set(
      n,
      new Promise<void>((resolve) => {
        reached.set(n, resolve)
      }),
    )
    held.set(
      n,
      new Promise<void>((resolve) => {
        release.set(n, resolve)
      }),
    )
  }
  let reads = 0
  const vfs = {
    links: inner.vfs.links,
    read: async (path: string, options?: { raw?: boolean }): Promise<Uint8Array> => {
      const n = reads++
      const bytes = await inner.vfs.read(path, options)
      const hold = held.get(n)
      if (hold !== undefined) {
        reached.get(n)?.()
        await hold
      }
      return bytes
    },
    write: (path: string, content: string): Promise<void> => inner.vfs.write(path, content),
    exists: (path: string): Promise<boolean> => inner.vfs.exists(path),
  } as unknown as Ops
  return { vfs, fetched, release }
}

describe('fingerprint', () => {
  it('is the unpadded base64url sha256 the Python tracker stamps', async () => {
    const stamp = await fingerprint(new TextEncoder().encode('hello'))
    expect(stamp).toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
  })
})

describe('FileVersionTracker', () => {
  it('shows and stamps a write that lands while a read of the old bytes is in flight', async () => {
    await ws.vfs.write('/a.txt', 'one')
    const held = heldVfs(ws, [0])
    const tracker = new FileVersionTracker(held.vfs)
    const reading = tracker.read('/a.txt')
    await held.fetched.get(0)
    await tracker.write('/a.txt', 'two')
    held.release.get(0)?.()
    expect(new TextDecoder().decode(await reading)).toBe('two')
    await tracker.write('/a.txt', 'three')
    expect(await ws.vfs.cat('/a.txt')).toBe('three')
  })

  it('keeps the shown stamp when writes land during both fetches of a read', async () => {
    await ws.vfs.write('/a.txt', 'one')
    const held = heldVfs(ws, [0, 2])
    const tracker = new FileVersionTracker(held.vfs)
    const reading = tracker.read('/a.txt')
    await held.fetched.get(0)
    await tracker.write('/a.txt', 'two')
    held.release.get(0)?.()
    await held.fetched.get(2)
    await tracker.write('/a.txt', 'three')
    held.release.get(2)?.()
    expect(new TextDecoder().decode(await reading)).toBe('two')
    await expect(tracker.write('/a.txt', 'four')).rejects.toThrow(StaleMirageFileError)
    expect(await ws.vfs.cat('/a.txt')).toBe('three')
  })

  it('hands back bytes the caller can change without changing the file', async () => {
    const tracker = new FileVersionTracker(ws.vfs)
    await ws.vfs.write('/a.txt', 'one')
    const bytes = await tracker.read('/a.txt')
    bytes[0] = 0x4f
    expect(await ws.vfs.cat('/a.txt')).toBe('one')
  })

  it('refuses a write to a file that changed underneath', async () => {
    const tracker = new FileVersionTracker(ws.vfs)
    await ws.vfs.write('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.vfs.write('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
  })

  it('allows a write that follows its own write', async () => {
    const tracker = new FileVersionTracker(ws.vfs)
    await ws.vfs.write('/a.txt', 'one')
    await tracker.read('/a.txt')
    await tracker.write('/a.txt', 'two')
    await tracker.write('/a.txt', 'three')
    expect(await ws.vfs.cat('/a.txt')).toBe('three')
  })

  it('stamps what a later read returns, not the bytes handed in', async () => {
    // Stamping the input would disagree with every later check, which
    // reads it back through the render, and the agent's own next write
    // would be refused as somebody else's change.
    const tracker = new FileVersionTracker(renderingVfs(ws))
    await tracker.write('/a.txt', 'one')
    await tracker.write('/a.txt', 'two')
    expect(await ws.vfs.cat('/a.txt')).toBe('two')
  })

  it('reads for edit after its own write on a rendering mount', async () => {
    const tracker = new FileVersionTracker(renderingVfs(ws))
    await tracker.write('/a.txt', 'one')
    expect(new TextDecoder().decode(await tracker.readForEdit('/a.txt'))).toBe('rendered:one')
  })

  it('gives an alias and its target one stamp', async () => {
    // readFile follows the symlink table, so these two spellings are one
    // file. Keyed by spelling, the write below would find no stamp for
    // '/a.txt' and clobber a change the agent never saw.
    const tracker = new FileVersionTracker(ws.vfs)
    await ws.vfs.write('/a.txt', 'one')
    expect((await ws.shell('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/alias.txt')
    await ws.vfs.write('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
    expect(await ws.vfs.cat('/a.txt')).toBe('moved underneath')
  })

  it('sees the target read when the edit arrives through the alias', async () => {
    const tracker = new FileVersionTracker(ws.vfs)
    await ws.vfs.write('/a.txt', 'one')
    expect((await ws.shell('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/a.txt')
    await ws.vfs.write('/a.txt', 'moved underneath')
    await expect(tracker.readForEdit('/alias.txt')).rejects.toThrow(StaleMirageFileError)
  })

  it('serves every call unchecked when disabled', async () => {
    const tracker = new FileVersionTracker(ws.vfs, false)
    await ws.vfs.write('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.vfs.write('/a.txt', 'moved underneath')
    await tracker.write('/a.txt', 'two')
    expect(await ws.vfs.cat('/a.txt')).toBe('two')
  })
})
