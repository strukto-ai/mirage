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

import { describe, expect, it } from 'vitest'
import { Accessor } from '../../accessor/base.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import { assertListed, listedSize, resolveEntry } from './probe.ts'
import { makeReaddir, type Lister } from './readdir.ts'
import { Slot, Scope, makeDetectScope } from './scope.ts'

const SCOPES: readonly Scope[] = [
  new Scope({ kind: 'rooms', segments: ['rooms'], probed: false }),
  new Scope({ kind: 'room', segments: ['rooms', new Slot('room')] }),
  new Scope({
    kind: 'note',
    segments: ['rooms', new Slot('room'), new Slot('note', JSON_NAME)],
    leaf: true,
    filetype: ContentType.JSON,
  }),
]

const detectScope = makeDetectScope(SCOPES)

const TREE: Record<string, string[]> = {
  rooms: ['red', 'blue'],
  red: ['a.json', 'b.json'],
  blue: [],
}

class FakeAccessor extends Accessor {
  readonly calls: string[] = []
}

function spec(mountPath: string): PathSpec {
  const key = stripSlash(mountPath)
  return new PathSpec({
    virtual: key !== '' ? `/h${mountPath}` : '/h',
    directory: '/h/',
    resourcePath: key,
  })
}

const listRooms: Lister<FakeAccessor> = (accessor, _match) => {
  accessor.calls.push('rooms')
  return Promise.resolve(
    (TREE.rooms ?? []).map((room): [string, IndexEntry] => [
      room,
      new IndexEntry({ id: room, name: room, resourceType: 'fake/room', vfsName: room }),
    ]),
  )
}

const listNotes: Lister<FakeAccessor> = (accessor, match) => {
  const room = match.slots.room ?? ''
  accessor.calls.push(`notes:${room}`)
  return Promise.resolve(
    (TREE[room] ?? []).map((note): [string, IndexEntry] => [
      note,
      new IndexEntry({ id: note, name: note, resourceType: 'fake/note', vfsName: note, size: 7 }),
    ]),
  )
}

const READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: {
    rooms: listRooms,
    room: listNotes,
  },
  staticRoot: ['rooms'],
})

describe('hierarchy probe', () => {
  it('assertListed accepts a listed child', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      assertListed(READDIR, new FakeAccessor(), spec('/rooms/red/a.json'), index),
    ).resolves.toBeUndefined()
  })

  it('assertListed refuses an absent child', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      assertListed(READDIR, new FakeAccessor(), spec('/rooms/red/nope.json'), index),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('listedSize reads what the listing recorded', async () => {
    const index = new RAMIndexCacheStore()
    const path = spec('/rooms/red/a.json')
    await assertListed(READDIR, new FakeAccessor(), path, index)
    expect(await listedSize(index, path)).toBe(7)
    expect(await listedSize(index, spec('/rooms/red/ghost.json'))).toBeNull()
  })

  it('resolveEntry warms the parent once', async () => {
    const index = new RAMIndexCacheStore()
    const accessor = new FakeAccessor()
    const entry = await resolveEntry(READDIR, accessor, spec('/rooms/red/a.json'), index)
    expect(entry?.id).toBe('a.json')
    expect(accessor.calls).toEqual(['notes:red'])
    // A warm cache answers from the index without another listing.
    const again = await resolveEntry(READDIR, accessor, spec('/rooms/red/b.json'), index)
    expect(again).not.toBeNull()
    expect(accessor.calls).toEqual(['notes:red'])
  })

  it('resolveEntry answers null for an absent child or a missing index', async () => {
    const index = new RAMIndexCacheStore()
    expect(
      await resolveEntry(READDIR, new FakeAccessor(), spec('/rooms/red/nope.json'), index),
    ).toBeNull()
    expect(await resolveEntry(READDIR, new FakeAccessor(), spec('/rooms/red/a.json'))).toBeNull()
  })
})
