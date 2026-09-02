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
import type * as ClientModule from './client.ts'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return { ...actual, latestFile: vi.fn(), filesColl: vi.fn() }
})

import { PathSpec } from '@struktoai/mirage-core/types'
import { GridFSAccessor } from '../../accessor/gridfs.ts'
import type { GridFSConfig } from '../../resource/gridfs/config.ts'
import * as clientMod from './client.ts'
import { liveIdentity } from './identity.ts'

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

describe('gridfs identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the gridfs id as both markers for a found file', async () => {
    vi.mocked(clientMod.latestFile).mockResolvedValue({
      filename: 'a.txt',
      _id: { toString: () => 'abc123' },
      length: 5,
      uploadDate: new Date('2026-01-01T00:00:00.000Z'),
    } as never)
    const result = await liveIdentity(accessor(), path('/a.txt'))
    expect(result.exists).toBe(true)
    expect(result.revision).toBe('abc123')
    expect(result.fingerprint).toBe('abc123')
  })

  it('a head miss with a probe hit is a directory', async () => {
    vi.mocked(clientMod.latestFile).mockResolvedValue(null)
    vi.mocked(clientMod.filesColl).mockResolvedValue({
      findOne: () => Promise.resolve({ _id: 'marker' }),
    } as never)
    await expect(liveIdentity(accessor(), path('/dir'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('a head miss with a probe miss is absent', async () => {
    vi.mocked(clientMod.latestFile).mockResolvedValue(null)
    vi.mocked(clientMod.filesColl).mockResolvedValue({
      findOne: () => Promise.resolve(null),
    } as never)
    const result = await liveIdentity(accessor(), path('/never.txt'))
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('the mount root is a directory without a lookup', async () => {
    vi.mocked(clientMod.latestFile).mockImplementation(() => {
      throw new Error('mount root must not reach the store')
    })
    await expect(liveIdentity(accessor(), path('/'))).rejects.toMatchObject({ code: 'EISDIR' })
  })
})
