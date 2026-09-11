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
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import type { ReaddirFn } from './probe.ts'
import { makeReaddir, type Lister } from './readdir.ts'
import { Slot, Scope, makeDetectScope } from './scope.ts'
import { makeUnlink, type DeleteFn } from './unlink.ts'

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
      new IndexEntry({ id: note, name: note, resourceType: 'fake/note', vfsName: note }),
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

const del: DeleteFn<FakeAccessor> = (accessor, _match, entry) => {
  accessor.calls.push(`delete:${entry.id}`)
  return Promise.resolve()
}

const UNLINK = makeUnlink<FakeAccessor>(detectScope, READDIR, { deleters: { note: del } })

const readdirAbsent: ReaddirFn<FakeAccessor> = (_accessor, path, _index) =>
  Promise.reject(enoent(path.virtual))

describe('hierarchy makeUnlink', () => {
  it('resolves and deletes the entry, then invalidates the parent', async () => {
    const index = new RAMIndexCacheStore()
    const accessor = new FakeAccessor()
    await UNLINK(accessor, spec('/rooms/red/a.json'), index)
    expect(accessor.calls).toEqual(['notes:red', 'delete:a.json'])
    const listing = await index.listDir('/h/rooms/red')
    expect(listing.entries ?? null).toBeNull()
  })

  it('refuses a directory', async () => {
    await expect(UNLINK(new FakeAccessor(), spec('/rooms/red'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(UNLINK(new FakeAccessor(), spec('/'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('answers missing or invalid paths with ENOENT', async () => {
    const index = new RAMIndexCacheStore()
    await expect(
      UNLINK(new FakeAccessor(), spec('/rooms/red/nope.json'), index),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(UNLINK(new FakeAccessor(), spec('/halls/x.json'), index)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('propagates a parent refresh failure', async () => {
    const broken: ReaddirFn<FakeAccessor> = () => Promise.reject(new Error('backend unavailable'))
    const unlink = makeUnlink<FakeAccessor>(detectScope, broken, { deleters: { note: del } })
    await expect(
      unlink(new FakeAccessor(), spec('/rooms/red/a.json'), new RAMIndexCacheStore()),
    ).rejects.toThrow('backend unavailable')
  })

  it('names the operand when the parent is absent', async () => {
    const unlink = makeUnlink<FakeAccessor>(detectScope, readdirAbsent, {
      deleters: { note: del },
    })
    const path = spec('/rooms/red/a.json')
    await expect(unlink(new FakeAccessor(), path, new RAMIndexCacheStore())).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(unlink(new FakeAccessor(), path, new RAMIndexCacheStore())).rejects.toThrow(
      path.virtual,
    )
  })
})
