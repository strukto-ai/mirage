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

import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { checksum } from './checksum.ts'
import { ROOT, answering, multistatus } from './mock.ts'

const SHA1 = 'a'.repeat(40)
const MD5 = 'b'.repeat(32)
const FILE = new PathSpec({
  virtual: '/nc/a b.txt',
  directory: '/nc',
  vfsPath: 'a b.txt',
  rawPath: '/nc/a b.txt',
})

function sums(text: string, kind = '<d:resourcetype/>'): string {
  return multistatus(
    '200 OK',
    `${kind}<oc:checksums xmlns:oc="http://owncloud.org/ns">` +
      `<oc:checksum>${text}</oc:checksum></oc:checksums>`,
  )
}

const accessor = (): NextcloudAccessor => new NextcloudAccessor({ url: `${ROOT}/` })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextcloud checksum', () => {
  it.each([
    ['sha1', SHA1],
    ['md5', MD5],
  ])('is the %s digest Nextcloud keeps', async (algorithm, digest) => {
    const fetchMock = answering(207, sums(`SHA1:${SHA1} MD5:${MD5} ADLER32:01234567`))
    expect(await checksum(accessor(), FILE, algorithm)).toBe(digest)
    const [url, init] = fetchMock.mock.lastCall ?? []
    expect(url).toBe(`${ROOT}/a%20b.txt`)
    expect(init?.method).toBe('PROPFIND')
    expect((init?.headers as Record<string, string>).Depth).toBe('0')
  })

  it('reads a digest case-insensitively', async () => {
    answering(207, sums(`sha1:${SHA1.toUpperCase()}`))
    expect(await checksum(accessor(), FILE, 'sha1')).toBe(SHA1)
  })

  it.each([
    ['another algorithm', sums(`MD5:${MD5}`)],
    ['no digest', sums('')],
    ['a short digest', sums(`SHA1:${SHA1.slice(1)}`)],
    ['a non-hex digest', sums(`SHA1:${SHA1.slice(1)}g`)],
    ['a collection', sums(`SHA1:${SHA1}`, '<d:resourcetype><d:collection/></d:resourcetype>')],
    [
      'a property not found',
      multistatus('404 Not Found', '<oc:checksums xmlns:oc="http://owncloud.org/ns"/>'),
    ],
  ])('leaves the read on %s', async (_name, body) => {
    answering(207, body)
    expect(await checksum(accessor(), FILE, 'sha1')).toBeNull()
  })

  it('leaves the read on anything but a multistatus', async () => {
    answering(404)
    expect(await checksum(accessor(), FILE, 'sha1')).toBeNull()
  })

  it('asks nothing for an algorithm Nextcloud keeps none of', async () => {
    const fetchMock = answering(207, sums(`SHA1:${SHA1}`))
    expect(await checksum(accessor(), FILE, 'sha512')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
