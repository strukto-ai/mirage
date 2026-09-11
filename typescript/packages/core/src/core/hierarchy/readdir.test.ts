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
import { DATE, JSON_NAME } from './codec.ts'
import { makeReaddir, type EntryLister, type Guard, type Lister } from './readdir.ts'
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
  new Scope({ kind: 'room_atts', segments: ['rooms', new Slot('room'), 'atts'] }),
  new Scope({ kind: 'room_day', segments: ['rooms', new Slot('room'), new Slot('day', DATE)] }),
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

describe('hierarchy makeReaddir', () => {
  it('lists a static root without any call', async () => {
    const accessor = new FakeAccessor()
    expect(await READDIR(accessor, spec('/'))).toEqual(['/h/rooms'])
    expect(accessor.calls).toEqual([])
  })

  it('joins names under the virtual key at a dynamic level', async () => {
    const accessor = new FakeAccessor()
    expect(await READDIR(accessor, spec('/rooms'))).toEqual(['/h/rooms/red', '/h/rooms/blue'])
  })

  it('runs the guard before the index probe', async () => {
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    await READDIR(accessor, spec('/rooms/red'), index)
    await READDIR(accessor, spec('/rooms/red'), index)
    // Two guard calls, one lister call: the second hit was served from the
    // index but still had to prove the room exists.
    expect(accessor.calls).toEqual(['guard:red', 'notes:red', 'guard:red'])
  })

  it('turns a guard failure into ENOENT even for a listable shape', async () => {
    await expect(READDIR(new FakeAccessor(), spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses leaf and invalid paths', async () => {
    await expect(READDIR(new FakeAccessor(), spec('/rooms/red/a.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(READDIR(new FakeAccessor(), spec('/halls'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('drops dot-prefixed names from listings', async () => {
    // The classifier refuses every dot-leading segment, so a listing must
    // not advertise one (a quoted postgres schema can be named ".foo").
    const hiddenRooms: Lister<FakeAccessor> = async (accessor, match) => {
      const listed = (await listRooms(accessor, match)) ?? []
      const rooms = Array.isArray(listed) ? listed : listed.entries
      const entry = rooms[0]?.[1]
      if (entry === undefined) throw new Error('fixture rooms empty')
      return [['.secret', entry], ...rooms]
    }
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: hiddenRooms },
      staticRoot: ['rooms'],
    })
    const index = new RAMIndexCacheStore()
    const out = await readdir(new FakeAccessor(), spec('/rooms'), index)
    expect(out).toEqual(['/h/rooms/red', '/h/rooms/blue'])
    const cached = await index.listDir('/h/rooms')
    expect(cached.entries).toEqual(['/h/rooms/red', '/h/rooms/blue'])
  })

  it('can answer a leaf with ENOTDIR', async () => {
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: listRooms },
      staticRoot: ['rooms'],
      leafError: 'enotdir',
    })
    await expect(readdir(new FakeAccessor(), spec('/rooms/red/a.json'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })
})

const entryNotes: EntryLister<FakeAccessor> = (accessor, _match, entry) => {
  accessor.calls.push(`entry-notes:${entry.id}`)
  return Promise.resolve([
    [
      'note.json',
      new IndexEntry({
        id: entry.id,
        name: 'note.json',
        resourceType: 'fake/note',
        vfsName: 'note.json',
      }),
    ],
  ])
}

const ENTRY_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: { room: entryNotes },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir entry listers', () => {
  it('resolves the directory through the parent listing', async () => {
    // The kit warms the parent listing once and hands the directory's own
    // entry to the lister; the lister never re-fetches its ancestors.
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    const out = await ENTRY_READDIR(accessor, spec('/rooms/red'), index)
    expect(out).toEqual(['/h/rooms/red/note.json'])
    expect(accessor.calls).toEqual(['rooms', 'entry-notes:red'])
    await ENTRY_READDIR(accessor, spec('/rooms/blue'), index)
    // The second room resolves from the already-cached rooms listing.
    expect(accessor.calls).toEqual(['rooms', 'entry-notes:red', 'entry-notes:blue'])
  })

  it('reports an unlisted container as ENOENT', async () => {
    const accessor = new FakeAccessor()
    await expect(ENTRY_READDIR(accessor, spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(accessor.calls).toEqual(['rooms'])
  })

  it('works without an index', async () => {
    // A caller with no cache gets a call-local one, so the parent warm
    // still feeds the entry resolution.
    const out = await ENTRY_READDIR(new FakeAccessor(), spec('/rooms/red'))
    expect(out).toEqual(['/h/rooms/red/note.json'])
  })

  it('refuses a kind named in both lister tables at build', () => {
    expect(() =>
      makeReaddir<FakeAccessor>(detectScope, {
        listers: { room: listNotes },
        entryListers: { room: entryNotes },
        staticRoot: ['rooms'],
      }),
    ).toThrow('kinds in several lister tables')
  })
})

const seedingNotes: EntryLister<FakeAccessor> = (accessor, match, own) => {
  accessor.calls.push(`seed-notes:${match.slots.room ?? ''}`)
  const atts = new IndexEntry({
    id: `${own.id}:atts`,
    name: 'atts',
    resourceType: 'fake/atts',
    vfsName: 'atts',
  })
  const blob = new IndexEntry({
    id: 'x',
    name: 'x.bin',
    resourceType: 'fake/blob',
    vfsName: 'x.bin',
    size: 3,
  })
  return Promise.resolve({
    entries: [['atts', atts]] as [string, IndexEntry][],
    seeds: { atts: [['x.bin', blob]] as [string, IndexEntry][] },
  })
}

const attsFallback: EntryLister<FakeAccessor> = (accessor, match) => {
  accessor.calls.push(`atts-fallback:${match.slots.room ?? ''}`)
  return Promise.resolve<[string, IndexEntry][]>([])
}

const SEEDED_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: {
    room: seedingNotes,
    room_atts: attsFallback,
  },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir seeded listings', () => {
  it('serves the seeded child listing without a second fetch', async () => {
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    await SEEDED_READDIR(accessor, spec('/rooms/red'), index)
    const out = await SEEDED_READDIR(accessor, spec('/rooms/red/atts'), index)
    expect(out).toEqual(['/h/rooms/red/atts/x.bin'])
    // One fetch answered both directories; the atts lister never ran.
    expect(accessor.calls).toEqual(['rooms', 'seed-notes:red'])
  })

  it('re-checks the listing after resolving the entry', async () => {
    // A cold readdir of the seeded child resolves its own entry, which
    // warms the seeding parent; the re-check then serves the listing the
    // warm just wrote instead of running the fallback lister.
    const accessor = new FakeAccessor()
    const out = await SEEDED_READDIR(accessor, spec('/rooms/red/atts'), new RAMIndexCacheStore())
    expect(out).toEqual(['/h/rooms/red/atts/x.bin'])
    expect(accessor.calls).toEqual(['rooms', 'seed-notes:red'])
  })
})

const daysByRoom: EntryLister<FakeAccessor> = (accessor, match, roomEntry) => {
  const day = match.slots.day ?? ''
  accessor.calls.push(`days:${roomEntry.id}:${day}`)
  return Promise.resolve<[string, IndexEntry][]>([
    [
      `${day}.txt`,
      new IndexEntry({
        id: `${roomEntry.id}:${day}`,
        name: `${day}.txt`,
        resourceType: 'fake/day_note',
        vfsName: `${day}.txt`,
      }),
    ],
  ])
}

const PARENT_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: { room: entryNotes },
  parentEntryListers: { room_day: daysByRoom },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir parent-entry listers', () => {
  it('is proven by the parent entry, not its own', async () => {
    // The day dir has no entry of its own (the room listing never minted
    // one); the proof is the room entry, handed to the lister.
    const accessor = new FakeAccessor()
    const out = await PARENT_READDIR(accessor, spec('/rooms/red/2024-01-15'))
    expect(out).toEqual(['/h/rooms/red/2024-01-15/2024-01-15.txt'])
    expect(accessor.calls).toEqual(['rooms', 'days:red:2024-01-15'])
  })

  it('throws ENOENT for a bogus parent', async () => {
    const accessor = new FakeAccessor()
    await expect(PARENT_READDIR(accessor, spec('/rooms/ghost/2024-01-15'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(accessor.calls).toEqual(['rooms'])
  })

  it('refuses a kind named in several lister tables at build', () => {
    expect(() =>
      makeReaddir<FakeAccessor>(detectScope, {
        listers: { rooms: listRooms },
        entryListers: { room_day: attsFallback },
        parentEntryListers: { room_day: daysByRoom },
        staticRoot: ['rooms'],
      }),
    ).toThrow('kinds in several lister tables')
  })
})

// Stands in for a bounded listing: without a glob it reports the tail of the
// tree, with one it reports exactly what the glob asked for.
const listWindowed: Lister<FakeAccessor> = (accessor, match) => {
  accessor.calls.push(`window:${match.pattern ?? 'null'}`)
  const names = match.pattern === null ? ['c.json'] : [match.pattern]
  const entries = names.map((n): [string, IndexEntry] => [
    n,
    new IndexEntry({ id: n, name: n, resourceType: 'fake/note', vfsName: n }),
  ])
  return Promise.resolve({ entries, seeds: {}, partial: match.pattern !== null })
}

const anyPattern = (_pattern: string): boolean => true

const WINDOW_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms, room: listWindowed },
  staticRoot: ['rooms'],
  patternKinds: { room: anyPattern },
})

function globbed(mountPath: string, pattern: string): PathSpec {
  const base = spec(mountPath)
  return new PathSpec({
    virtual: `${base.virtual}/${pattern}`,
    directory: `${base.virtual}/`,
    resourcePath: `${base.resourcePath}/${pattern}`,
    pattern,
  })
}

describe('a windowed listing honours a glob', () => {
  it('hands the glob to a declared kind, and nothing to an undeclared one', async () => {
    const accessor = new FakeAccessor()
    expect(await WINDOW_READDIR(accessor, globbed('/rooms/red', 'z.json'))).toEqual([
      '/h/rooms/red/z.json',
    ])
    const plain = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: listRooms, room: listWindowed },
      staticRoot: ['rooms'],
    })
    expect(await plain(accessor, globbed('/rooms/red', 'z.json'))).toEqual(['/h/rooms/red/c.json'])
    expect(accessor.calls).toEqual(['window:z.json', 'window:null'])
  })

  it('does not cache a partial listing as the directory', async () => {
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    await WINDOW_READDIR(accessor, globbed('/rooms/red', 'z.json'), index)
    // The entries are real, so they are cached one by one; the directory is
    // not, so a bare listing still asks the backend.
    expect((await index.get('/h/rooms/red/z.json')).entry).not.toBeNull()
    const listed = await index.listDir('/h/rooms/red')
    expect(listed.entries === undefined || listed.entries === null).toBe(true)
    expect(await WINDOW_READDIR(accessor, spec('/rooms/red'), index)).toEqual([
      '/h/rooms/red/c.json',
    ])
    expect(accessor.calls).toEqual(['window:z.json', 'window:null'])
  })

  it('does not answer a glob from a warm window', async () => {
    const accessor = new FakeAccessor()
    const index = new RAMIndexCacheStore()
    await WINDOW_READDIR(accessor, spec('/rooms/red'), index)
    expect(await WINDOW_READDIR(accessor, globbed('/rooms/red', 'z.json'), index)).toEqual([
      '/h/rooms/red/z.json',
    ])
    expect(accessor.calls).toEqual(['window:null', 'window:z.json'])
  })
})
