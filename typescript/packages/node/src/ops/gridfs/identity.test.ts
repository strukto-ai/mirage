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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../../core/gridfs/client.ts'

vi.mock('../../core/gridfs/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../core/gridfs/client.ts')
  return { ...actual, latestFile: vi.fn(), filesColl: vi.fn() }
})

import type {
  IndexEntry,
  ListResult,
  LookupResult,
} from '@struktoai/mirage-core/cache/index/config'
import { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import * as clientMod from '../../core/gridfs/client.ts'
import type { GridFSConfig } from '../../resource/gridfs/config.ts'
import { liveIdentityOp } from './identity.ts'

/** An index cache that fails loudly if the op ever consults it. */
class PoisonIndex extends IndexCacheStore {
  get(_resourcePath: string): Promise<LookupResult> {
    throw new Error('live_identity must not touch index.get')
  }
  put(_resourcePath: string, _entry: IndexEntry): Promise<void> {
    throw new Error('live_identity must not touch index.put')
  }
  listDir(_resourcePath: string): Promise<ListResult> {
    throw new Error('live_identity must not touch index.listDir')
  }
  setDir(): Promise<void> {
    throw new Error('live_identity must not touch index.setDir')
  }
  invalidateDir(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidateDir')
  }
  invalidatePrefix(_resourcePath: string): Promise<void> {
    throw new Error('live_identity must not touch index.invalidatePrefix')
  }
  invalidate(): Promise<void> {
    throw new Error('live_identity must not touch index.invalidate')
  }
  clear(): Promise<void> {
    throw new Error('live_identity must not touch index.clear')
  }
}

function accessor(): GridFSAccessor {
  return new GridFSAccessor({ uri: 'mongodb://localhost:27017', database: 'db' } as GridFSConfig)
}

function path(mountPath: string): PathSpec {
  const key = mountPath.replace(/^\/+|\/+$/g, '')
  return new PathSpec({
    virtual: key !== '' ? `/mnt${mountPath}` : '/mnt',
    directory: '/mnt/',
    resourcePath: key,
  })
}

describe('gridfs live_identity op', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores a poisoned index', async () => {
    vi.mocked(clientMod.latestFile).mockResolvedValue({
      filename: 'a.txt',
      _id: { toString: () => 'abc123' },
      length: 5,
      uploadDate: new Date('2026-01-01T00:00:00.000Z'),
    } as never)
    const result = (await liveIdentityOp.fn(accessor(), path('/a.txt'), [], {
      index: new PoisonIndex(),
    })) as { exists: boolean; revision: string | null; fingerprint: string | null }
    expect(result.exists).toBe(true)
    expect(result.revision).toBe('abc123')
    expect(result.fingerprint).toBe('abc123')
  })
})
