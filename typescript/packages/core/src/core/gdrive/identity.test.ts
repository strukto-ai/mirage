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
import type * as ClientModule from '../google/client.ts'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../google/client.ts')
  return { ...actual, googleGet: vi.fn(), googleGetBytes: vi.fn() }
})

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import { googleGet } from '../google/client.ts'
import { PathSpec } from '../../types.ts'
import { type FakeDrive, makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { liveIdentity } from './identity.ts'

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

describe('gdrive identity', () => {
  it('returns markers for a found file', async () => {
    fake.add('a.txt', 'root', undefined, ENC.encode('hi'))
    vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r9', md5Checksum: 'abc' })
    const result = await liveIdentity(accessor, path('a.txt'))
    expect(result.exists).toBe(true)
    expect(result.revision).toBe('r9')
    expect(result.fingerprint).toBe('abc')
  })

  it('reports exists false for a missing path', async () => {
    fake.folder('a')
    const result = await liveIdentity(accessor, path('a/missing.txt'))
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })

  it('raises EISDIR for a folder', async () => {
    fake.folder('dir')
    await expect(liveIdentity(accessor, path('dir'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR on the mount root without resolving', async () => {
    await expect(liveIdentity(accessor, path(''))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('raises EISDIR for a folder spelled with a trailing slash', async () => {
    // Drive is id-addressed and the key the resolver walks carries no
    // trailing slash, so the hint costs nothing: the folder resolves and
    // the file-only contract refuses it, the same as without the slash.
    fake.folder('dir')
    const slashed = new PathSpec({ virtual: '/dir/', directory: '/', resourcePath: 'dir' })
    await expect(liveIdentity(accessor, slashed)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('reports exists false for an absent path spelled with a trailing slash', async () => {
    fake.folder('a')
    const slashed = new PathSpec({ virtual: '/a/gone/', directory: '/a', resourcePath: 'a/gone' })
    const result = await liveIdentity(accessor, slashed)
    expect(result.exists).toBe(false)
    expect(result.revision).toBeNull()
    expect(result.fingerprint).toBeNull()
  })
})
