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

import { statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { IndexEntry, ResourceType } from '@struktoai/mirage-core/cache/index/config'
import { FileType, MountMode, ReadPolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { Reconciler } from '@struktoai/mirage-core/workspace/reconcile'
import { spec, tmpRoot } from '../../test-utils.ts'
import { DiskVFS } from '../../vfs/disk/disk.ts'
import { Workspace } from '../../workspace.ts'
import { stat } from './stat.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-stat-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/stat', () => {
  it('returns FileStat with size and modified for a file', async () => {
    await writeFile(join(root, 'a.txt'), 'abc')
    const s = await stat(accessor, spec('/a.txt'))
    expect(s.size).toBe(3)
    expect(s.modified).not.toBeNull()
  })

  it('returns DIRECTORY type for a directory', async () => {
    await mkdir(join(root, 'd'))
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.size).toBeNull()
  })

  it('throws "file not found" on missing', async () => {
    await expect(stat(accessor, spec('/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('core/disk/stat folder probe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([false, true])(
    'a folder with an overlay still drops the index under fresh (quiet: %s)',
    async (quiet) => {
      const folder = join(root, 'd')
      await mkdir(folder)
      if (quiet) {
        // Past the racy window the folder's stat carries a version, so the
        // probe compares it instead of finding no fingerprint at all.
        const st = statSync(folder, { bigint: true })
        const changed = st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Number(changed / 1000000n) + 3000)
      }
      const ws = new Workspace({
        '/m': new Mount(new DiskVFS({ root }), {
          mode: MountMode.WRITE,
          read: { policy: ReadPolicy.FRESH, ttl: 600 },
        }),
      })
      try {
        await ws.namespace.ensureLoaded()
        await ws.namespace.setAttrs('/m/d', { uid: 1000 })
        const mount = ws.namespace.mountFor('/m/d')
        await mount.indexStore.setDir('/m/d', [
          [
            'x.txt',
            new IndexEntry({ id: '/d/x.txt', name: 'x.txt', resourceType: ResourceType.FILE }),
          ],
        ])
        expect((await mount.indexStore.listDir('/m/d')).entries ?? null).not.toBeNull()
        await new Reconciler(ws.cache, ws.namespace).reconcileRead(mount, '/m/d')
        expect((await mount.indexStore.listDir('/m/d')).entries ?? null).toBeNull()
      } finally {
        await ws.close()
      }
    },
  )
})
