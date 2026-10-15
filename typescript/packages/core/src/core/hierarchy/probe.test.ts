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
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { Codec, DATE, JSON_NAME } from './codec.ts'
import { parentSpec, rowsUnder } from './probe.ts'
import { makeReaddir, type EntryLister, type Lister } from './readdir.ts'
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
  new Scope({ kind: 'room_day', segments: ['rooms', new Slot('room'), new Slot('day', DATE)] }),
  new Scope({
    kind: 'tagged',
    segments: ['tags', new Slot('tag', new Codec({ validate: (text) => /^[a-z]+$/.test(text) }))],
    leaf: true,
    filetype: ContentType.TEXT,
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
    vfsPath: key,
  })
}

const listRooms: Lister<FakeAccessor> = (accessor, _match) => {
  accessor.calls.push('rooms')
  return Promise.resolve(
    (TREE.rooms ?? []).map(
      (room) => new FileStat({ name: room, type: FileType.DIRECTORY, extra: { room_id: room } }),
    ),
  )
}

const listNotes: Lister<FakeAccessor> = (accessor, match) => {
  const room = match.slots.room ?? ''
  accessor.calls.push(`notes:${room}`)
  return Promise.resolve(
    (TREE[room] ?? []).map((note) => new FileStat({ name: note, type: FileType.FILE, size: 7 })),
  )
}

const notesOf: EntryLister<FakeAccessor> = (accessor, match, _entry) =>
  listNotes(accessor, match) as Promise<FileStat[]>

const READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: { room: notesOf },
  staticRoot: ['rooms'],
})

describe('hierarchy probe', () => {
  it('parentSpec is the directory holding the path', () => {
    const parent = parentSpec(spec('/rooms/red/a.json'))
    expect([parent.virtual, parent.vfsPath]).toEqual(['/h/rooms/red', 'rooms/red'])
  })

  it('rowsUnder walks every level handing each its row', async () => {
    const accessor = new FakeAccessor()
    const walked = await rowsUnder(READDIR, accessor, spec('/'), null)
    expect(walked.map(([path, row]) => [path.virtual, row.type])).toEqual([
      ['/h/rooms', FileType.DIRECTORY],
      ['/h/rooms/red', FileType.DIRECTORY],
      ['/h/rooms/blue', FileType.DIRECTORY],
      ['/h/rooms/red/a.json', FileType.FILE],
      ['/h/rooms/red/b.json', FileType.FILE],
    ])
    expect(accessor.calls).toEqual(['rooms', 'notes:blue', 'notes:red'])
  })
})
