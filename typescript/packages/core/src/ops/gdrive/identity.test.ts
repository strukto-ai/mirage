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
import type * as ClientModule from '../../core/google/client.ts'
import type * as DriveModule from '../../core/google/drive.ts'

vi.mock('../../core/google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../../core/google/client.ts')
  return { ...actual, googleGet: vi.fn(), googleGetBytes: vi.fn() }
})

vi.mock('../../core/google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../../core/google/drive.ts')
  const { driveModuleMock } = await import('../../core/gdrive/_test_util.ts')
  return driveModuleMock(actual)
})

import { googleGet } from '../../core/google/client.ts'
import { type FakeDrive, makeGDriveAccessor, resetFakeDrive } from '../../core/gdrive/_test_util.ts'
import type { IndexEntry, ListResult, LookupResult } from '../../cache/index/config.ts'
import { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
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

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
  vi.mocked(googleGet).mockReset()
})

function path(key: string): PathSpec {
  return new PathSpec({ virtual: `/${key}`, directory: '/', resourcePath: key })
}

describe('gdrive live_identity op', () => {
  it('ignores a poisoned index', async () => {
    fake.add('a.txt', 'root', undefined, ENC.encode('hi'))
    vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r9', md5Checksum: 'abc' })
    const result = (await liveIdentityOp.fn(accessor, path('a.txt'), [], {
      index: new PoisonIndex(),
    })) as { exists: boolean; revision: string | null; fingerprint: string | null }
    expect(result.exists).toBe(true)
    expect(result.revision).toBe('r9')
    expect(result.fingerprint).toBe('abc')
  })
})
