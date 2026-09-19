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

import { describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, bucket: vi.fn() }
})

import { runWithCacheManager } from '@struktoai/mirage-core/cache/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../vfs/gridfs/config.ts'
import * as clientMod from './client.ts'
import { write } from './write.ts'

class FakeManager {
  writes: string[] = []

  invalidateAfterWrite(path: PathSpec): Promise<void> {
    this.writes.push(path.mountPath)
    return Promise.resolve()
  }

  invalidateAfterUnlink(_path: PathSpec): Promise<void> {
    return Promise.resolve()
  }

  invalidateSubtree(_path: PathSpec): Promise<void> {
    return Promise.resolve()
  }

  cachedBytes(_path: PathSpec): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  cachedSize(_path: PathSpec): Promise<number | null> {
    return Promise.resolve(null)
  }
}

function fakeBucket(keys: string[]): unknown {
  return {
    openUploadStream: (key: string) => {
      keys.push(key)
      const handlers: Record<string, () => void> = {}
      return {
        on: (event: string, handler: () => void) => {
          handlers[event] = handler
        },
        end: () => {
          handlers.finish?.()
        },
      }
    },
  }
}

async function runWrite(mountPath: string): Promise<{ manager: FakeManager; keys: string[] }> {
  const keys: string[] = []
  vi.mocked(clientMod.bucket).mockResolvedValue(fakeBucket(keys) as never)
  const manager = new FakeManager()
  const accessor = new GridFSAccessor({
    uri: 'mongodb://localhost:27017',
    database: 'db',
  } as GridFSConfig)
  const spec = new PathSpec({
    vfsPath: mountPath.replace(/^\//, ''),
    virtual: `/mnt${mountPath}`,
    directory: '/mnt/',
  })
  await runWithCacheManager(manager, async () => {
    await write(accessor, spec, new TextEncoder().encode('hi'))
  })
  return { manager, keys }
}

describe('gridfs core write', () => {
  it('invalidates every ancestor listing', async () => {
    const { manager, keys } = await runWrite('/a/b/c.txt')
    expect(keys).toEqual(['a/b/c.txt'])
    // The upload materializes `a` and `a/b` too, so their listings are stale.
    expect(manager.writes).toEqual(['/a/b/c.txt', '/a/b', '/a'])
  })

  it('invalidates only itself at the mount root', async () => {
    const { manager } = await runWrite('/c.txt')
    expect(manager.writes).toEqual(['/c.txt'])
  })
})
