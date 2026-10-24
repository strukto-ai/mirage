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
import {
  FakeStore,
  makeAccessor,
  mockedClient,
  spec,
} from '../../../tests/core/gridfs/_test_util.ts'

let store = new FakeStore()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return mockedClient(actual, () => store)
})

import { readdir } from './readdir.ts'
import { rename } from './rename.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()
const EMPTY = new Uint8Array(0)

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

// Twins of tests/core/gridfs/test_rename.py.
describe('gridfs rename', () => {
  beforeEach(() => {
    store = new FakeStore()
  })

  it('moves a whole directory prefix', async () => {
    // A directory owns no revision, so the prefix retag has to carry it.
    for (const name of ['d/', 'd/f.txt', 'd/sub/g.txt', 'keep.txt']) store.upload(name, EMPTY)
    await rename(makeAccessor(store), spec('d'), spec('e'))
    expect(store.names()).toEqual(['e/', 'e/f.txt', 'e/sub/g.txt', 'keep.txt'])
  })

  it('replaces an empty destination directory', async () => {
    for (const name of ['src/', 'src/f.txt', 'dst/']) store.upload(name, EMPTY)
    await rename(makeAccessor(store), spec('src'), spec('dst'))
    expect([...store.names()].sort()).toEqual(['/trash/dst/', 'dst/', 'dst/f.txt'])
  })

  it('keeps moving a plain file', async () => {
    store.upload('a.txt', EMPTY)
    await rename(makeAccessor(store), spec('a.txt'), spec('b.txt'))
    expect(store.names()).toEqual(['b.txt'])
  })

  it('reports ENOENT for a missing source', async () => {
    store.upload('other.txt', EMPTY)
    await expect(codeOf(rename(makeAccessor(store), spec('ghost'), spec('e')))).resolves.toBe(
      'ENOENT',
    )
    expect(store.names()).toEqual(['other.txt'])
  })

  it('trashes the revisions of a file it overwrites', async () => {
    // An overwriting mv destroys no more than rm does: the destination's
    // revisions go to the trash, where a pinned read still finds them.
    store.upload('a.txt', ENC.encode('a'))
    store.upload('b.txt', ENC.encode('b1'))
    store.upload('b.txt', ENC.encode('b2'))
    const old = store.ids('b.txt')
    await rename(makeAccessor(store), spec('a.txt'), spec('b.txt'))
    expect([...store.names()].sort()).toEqual(['/trash/b.txt', '/trash/b.txt', 'b.txt'])
    expect(store.ids('/trash/b.txt')).toEqual(old)
  })

  it('does not resurrect trashed revisions', async () => {
    const accessor = makeAccessor(store)
    await write(accessor, spec('a.txt'), ENC.encode('old'))
    await unlink(accessor, spec('a.txt'))
    await write(accessor, spec('a.txt'), ENC.encode('new'))
    const [fresh] = store.ids('a.txt')
    await rename(accessor, spec('a.txt'), spec('b.txt'))
    expect(store.ids('b.txt')).toEqual([fresh])
    expect(store.ids('/trash/a.txt')).toHaveLength(1)
    expect((await readdir(accessor, spec(''))).map((row) => row.name)).toEqual(['b.txt'])
  })
})
