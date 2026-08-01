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

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core'
import { DiskResource } from '../resource/disk/disk.ts'
import { tmpRoot } from '../test-utils.ts'
import { Workspace } from '../workspace.ts'

// Disk carries a 60s index TTL, so a cached directory listing outlives a
// mutation unless something evicts it. Two paths reach the same ops with
// different guarantees, and both halves are load-bearing:
//
//   ws.dispatch -> Dispatcher, which calls invalidateAfterWriteByPath after
//   every write op (mirroring Python's Dispatcher.invalidate_after_write).
//   Forwarding the index here is safe.
//
//   ws.fs       -> OpsRegistry.call directly, never through the dispatcher,
//   so nothing evicts anything. This is the path patchNodeFs and FUSE use,
//   and it is why the ops factory still withholds the index from the mutable
//   local backends via `forwardIndex: false`.
function diskWorkspace(): { ws: Workspace; cleanup: () => void } {
  const { root, cleanup } = tmpRoot('mirage-index-invalidation-')
  mkdirSync(join(root, 'seed'))
  const ws = new Workspace(
    { '/d': [new DiskResource({ root }), MountMode.WRITE] },
    { mode: MountMode.WRITE },
  )
  return { ws, cleanup }
}

const names = (entries: unknown): string[] =>
  (entries as string[]).map((e) => e.replace(/\/$/, '').split('/').pop() as string).sort()

describe('dispatcher evicts the index after a write op', () => {
  it('readdir sees a directory created after the listing was cached', async () => {
    const { ws, cleanup } = diskWorkspace()
    try {
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['seed'])
      await ws.dispatch('mkdir', '/d/fresh')
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['fresh', 'seed'])
    } finally {
      await ws.close()
      cleanup()
    }
  })

  it('readdir sees a file written after the listing was cached', async () => {
    const { ws, cleanup } = diskWorkspace()
    try {
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['seed'])
      await ws.dispatch('write', '/d/note.txt', [new TextEncoder().encode('hi')])
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['note.txt', 'seed'])
    } finally {
      await ws.close()
      cleanup()
    }
  })

  it('readdir stops listing a directory removed after the listing was cached', async () => {
    const { ws, cleanup } = diskWorkspace()
    try {
      await ws.dispatch('mkdir', '/d/gone')
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['gone', 'seed'])
      await ws.dispatch('rmdir', '/d/gone')
      expect(names(await ws.dispatch('readdir', '/d/'))).toEqual(['seed'])
    } finally {
      await ws.close()
      cleanup()
    }
  })
})

describe('ws.fs bypasses the dispatcher, so its backends stay index-less', () => {
  // Dropping `forwardIndex: false` makes these fail: ws.fs.readdir caches the
  // listing into the index, ws.fs.mkdir never evicts it, and the next readdir
  // replays the pre-mutation entries for the whole 60s TTL.
  it('readdir reflects a mkdir issued through ws.fs', async () => {
    const { ws, cleanup } = diskWorkspace()
    try {
      expect(names(await ws.fs.readdir('/d'))).toEqual(['seed'])
      await ws.fs.mkdir('/d/sub')
      expect(names(await ws.fs.readdir('/d'))).toEqual(['seed', 'sub'])
    } finally {
      await ws.close()
      cleanup()
    }
  })

  it('readdir reflects a writeFile then unlink issued through ws.fs', async () => {
    const { ws, cleanup } = diskWorkspace()
    try {
      await ws.fs.writeFile('/d/a.txt', 'a')
      expect(names(await ws.fs.readdir('/d'))).toEqual(['a.txt', 'seed'])
      await ws.fs.unlink('/d/a.txt')
      expect(names(await ws.fs.readdir('/d'))).toEqual(['seed'])
    } finally {
      await ws.close()
      cleanup()
    }
  })
})
