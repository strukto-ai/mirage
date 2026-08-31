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
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import {
  type FakeDrive,
  addCollidingPair,
  makeGDriveAccessor,
  resetFakeDrive,
} from './_test_util.ts'
import { liveIdentity } from './identity.ts'
import { read } from './read.ts'
import { resolveKey } from './resolve.ts'

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

describe('identity and a warmed read on a duplicate name', () => {
  // The two halves of a read-check-write reach the file by different
  // routes: identity resolves the name with a direct query, the read
  // resolves it through the index the listing warmed. Disagreeing made
  // every such caller see a conflict with no writer.
  for (const newestFirst of [false, true]) {
    it(`name the same file (newest listed ${newestFirst ? 'first' : 'second'})`, async () => {
      const addOld = (): string =>
        fake.add('dup.txt', 'root', undefined, ENC.encode('old'), undefined, '2026-01-01T00:00:00Z')
      const addNew = (): string =>
        fake.add('dup.txt', 'root', undefined, ENC.encode('new'), undefined, '2026-06-01T00:00:00Z')
      let newest: string
      if (newestFirst) {
        newest = addNew()
        addOld()
      } else {
        addOld()
        newest = addNew()
      }
      const dup = path('dup.txt')

      expect((await resolveKey(accessor, 'dup.txt'))?.id).toBe(newest)

      const index = new RAMIndexCacheStore()
      const data = await read(accessor, dup, index)
      expect(data).toEqual(fake.items.get(newest)?.content)
      expect((await index.get('/dup.txt')).entry?.id).toBe(newest)

      vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r1', md5Checksum: 'abc' })
      const result = await liveIdentity(accessor, dup)
      expect(result.exists).toBe(true)
      // The identity was captured for the file the read delivered, not
      // for its same-named sibling.
      expect(vi.mocked(googleGet).mock.calls[0]?.[1]).toContain(newest)
    })
  }
})

describe('identity and a warmed read across the rendered-name boundary', () => {
  // The round-7 disagreement one level up. A binary file literally named
  // `x.gdoc.json` and a Google Doc named `x` render as one vfs name, and
  // the two routes reach them differently: the resolver ran a query per
  // name shape and answered from the first that matched, while the
  // listing ranked every item sharing the rendered name. So the resolver
  // could name the binary and the read the doc -- a permanent conflict
  // with no writer, on a path a read-check-write caller never gets past.
  for (const literalFirst of [true, false]) {
    for (const newer of ['literal', 'native'] as const) {
      it(`name the same file (${newer} newer, literal listed ${
        literalFirst ? 'first' : 'second'
      })`, async () => {
        const [literal, doc] = addCollidingPair(fake, literalFirst, newer)
        const expected = newer === 'literal' ? literal : doc
        const collided = path('x.gdoc.json')

        expect((await resolveKey(accessor, 'x.gdoc.json'))?.id).toBe(expected)

        // Serves readDoc when the native doc is the one that wins; the
        // binary read never reaches googleGet at all.
        vi.mocked(googleGet).mockResolvedValue({ title: 'x' })
        const index = new RAMIndexCacheStore()
        await read(accessor, collided, index)
        expect((await index.get('/x.gdoc.json')).entry?.id).toBe(expected)

        vi.mocked(googleGet).mockResolvedValueOnce({ headRevisionId: 'r1', md5Checksum: 'abc' })
        const result = await liveIdentity(accessor, collided)
        expect(result.exists).toBe(true)
        expect(vi.mocked(googleGet).mock.calls.at(-1)?.[1]).toContain(expected)
      })
    }
  }
})
