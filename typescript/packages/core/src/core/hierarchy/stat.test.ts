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
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import { makeReaddir, type Guard, type Lister } from './readdir.ts'
import { Slot, Scope, makeDetectScope } from './scope.ts'
import { makeStat, type EntryStatFn, type ExtraFn, type StatHook } from './stat.ts'

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

const roomGuard: Guard<FakeAccessor> = (accessor, match, virtual) => {
  const room = match.slots.room ?? ''
  accessor.calls.push(`guard:${room}`)
  if (!(TREE.rooms ?? []).includes(room)) return Promise.reject(enoent(virtual))
  return Promise.resolve()
}

const READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: {
    rooms: listRooms,
    room: listNotes,
  },
  staticRoot: ['rooms'],
  guards: { room: roomGuard },
})

const roomExtra: ExtraFn = (match) => ({ room: match.slots.room ?? '' })

const STAT = makeStat<FakeAccessor>(detectScope, READDIR, {
  guards: { room: roomGuard },
  extras: { room: roomExtra },
})

describe('hierarchy makeStat', () => {
  it('answers root and static dirs without probing', async () => {
    const accessor = new FakeAccessor()
    expect((await STAT(accessor, spec('/'))).name).toBe('/')
    const st = await STAT(accessor, spec('/rooms'))
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(st.name).toBe('rooms')
    expect(accessor.calls).toEqual([])
  })

  it('carries extras on a guarded dir', async () => {
    const accessor = new FakeAccessor()
    const st = await STAT(accessor, spec('/rooms/red'))
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(st.extra).toEqual({ room: 'red' })
    expect(accessor.calls).toEqual(['guard:red'])
  })

  it('proves a leaf exists through the parent listing', async () => {
    const index = new RAMIndexCacheStore()
    const st = await STAT(new FakeAccessor(), spec('/rooms/red/a.json'), index)
    expect(st.content).toBe(ContentType.JSON)
    expect(st.size).toBe(7)
    await expect(
      STAT(new FakeAccessor(), spec('/rooms/red/nope.json'), index),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('answers invalid shapes with ENOENT', async () => {
    await expect(STAT(new FakeAccessor(), spec('/halls'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(STAT(new FakeAccessor(), spec('/rooms/.red'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('lets an override replace the whole shape', async () => {
    const bespoke: StatHook<FakeAccessor> = (_accessor, _match, _path, _index) =>
      Promise.resolve(
        new FileStat({ name: 'custom', type: FileType.FILE, content: ContentType.TEXT, size: 1 }),
      )
    const stat = makeStat<FakeAccessor>(detectScope, READDIR, { overrides: { note: bespoke } })
    const accessor = new FakeAccessor()
    const st = await stat(accessor, spec('/rooms/red/a.json'))
    expect(st.name).toBe('custom')
    expect(accessor.calls).toEqual([])
  })

  it('builds an entry stat from the resolved entry', async () => {
    const fromEntry: EntryStatFn = (_match, _path, entry) =>
      new FileStat({
        name: entry.vfsName,
        type: FileType.FILE,
        content: ContentType.JSON,
        size: entry.size,
        extra: { doc_id: entry.id },
      })
    const stat = makeStat<FakeAccessor>(detectScope, READDIR, { entryStats: { note: fromEntry } })
    const index = new RAMIndexCacheStore()
    const st = await stat(new FakeAccessor(), spec('/rooms/red/a.json'), index)
    expect(st.name).toBe('a.json')
    expect(st.size).toBe(7)
    expect(st.extra).toEqual({ doc_id: 'a.json' })
    await expect(
      stat(new FakeAccessor(), spec('/rooms/red/nope.json'), index),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
