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
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('../../../tests/core/gdrive/_test_util.ts')
  return driveModuleMock(actual)
})

import { PathSpec } from '../../types.ts'
import { entryAt } from '../../../tests/workspace/fixtures/handed.ts'
import { readdir } from './readdir.ts'
import { GoogleApiError } from '../google/client.ts'
import type { FakeDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { makeGDriveAccessor, resetFakeDrive } from '../../../tests/core/gdrive/_test_util.ts'
import { filesContaining } from './search.ts'
import { PARENTS_PER_QUERY } from './tree.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function scope(vfsPath = ''): PathSpec {
  const virtual = vfsPath === '' ? '/gd' : `/gd/${vfsPath}`
  return new PathSpec({ virtual, directory: virtual, vfsPath, resolved: false })
}

async function ask(under: PathSpec): Promise<PathSpec[] | null> {
  return filesContaining(accessor, 'wombat', under, await entryAt(readdir, accessor, under))
}

describe('gdrive filesContaining', () => {
  it('answers the walked files Drive names', async () => {
    const sub = fake.folder('sub')
    fake.add('a.txt', 'root', undefined, ENC.encode('the wombat'))
    fake.add('b.txt', sub, undefined, ENC.encode('wombat here'))
    fake.add('c.txt', 'root', undefined, ENC.encode('nothing'))
    const out = await ask(scope())
    expect(out?.map((p) => p.virtual).sort()).toEqual(['/gd/a.txt', '/gd/sub/b.txt'])
    expect(fake.searches).toEqual([['root', sub]])
  })

  it('searches a subfolder scope from its folder', async () => {
    const sub = fake.folder('sub')
    fake.add('a.txt', 'root', undefined, ENC.encode('wombat'))
    fake.add('b.txt', sub, undefined, ENC.encode('wombat'))
    const out = await ask(scope('sub'))
    expect(out?.map((p) => [p.virtual, p.vfsPath])).toEqual([['/gd/sub/b.txt', 'sub/b.txt']])
    expect(fake.searches).toEqual([[sub]])
  })

  it('searches many folders in batches', async () => {
    for (let i = 0; i < PARENTS_PER_QUERY + 5; i++) fake.folder(`d${String(i).padStart(2, '0')}`)
    fake.add('a.txt', 'root', undefined, ENC.encode('wombat'))
    expect(await ask(scope())).not.toBeNull()
    expect(fake.searches.map((s) => s.length)).toEqual([PARENTS_PER_QUERY, 6])
  })

  it.each([
    ['no hit', () => undefined],
    [
      'an incomplete search',
      () => {
        fake.incomplete = true
      },
    ],
    [
      'a failed search',
      () => vi.spyOn(fake, 'searchFiles').mockRejectedValue(new GoogleApiError('down', 500)),
    ],
    [
      'a timed-out search',
      () =>
        vi
          .spyOn(fake, 'searchFiles')
          .mockRejectedValue(new DOMException('timed out', 'TimeoutError')),
    ],
    [
      'a failed listing',
      () => vi.spyOn(fake, 'listChildren').mockRejectedValue(new TypeError('fetch failed')),
    ],
  ])('answers null for %s', async (name, breakIt) => {
    fake.add('a.txt', 'root', undefined, ENC.encode(name === 'no hit' ? 'nothing' : 'wombat'))
    breakIt()
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    expect(await ask(scope())).toBeNull()
  })
})
