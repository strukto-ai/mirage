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
import { ContentType, DirListing, FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { Codec, DATE, JSON_NAME } from './codec.ts'
import {
  cutListing,
  heldPages,
  makeReaddir,
  type EntryLister,
  type Guard,
  type Listed,
  type Lister,
} from './readdir.ts'
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

const roomGuard: Guard<FakeAccessor> = (accessor, match, virtual) => {
  const room = match.slots.room ?? ''
  accessor.calls.push(`guard:${room}`)
  if (!(TREE.rooms ?? []).includes(room)) return Promise.reject(enoent(virtual))
  return Promise.resolve()
}

const READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms, room: listNotes },
  staticRoot: ['rooms'],
  guards: { room: roomGuard },
})

function rowsOf(listed: Listed): readonly FileStat[] {
  return listed instanceof DirListing ? listed.entries : listed
}

function names(listed: Listed): string[] {
  return rowsOf(listed).map((row) => row.name)
}

describe('hierarchy makeReaddir', () => {
  it('lists a static root without any call', async () => {
    const accessor = new FakeAccessor()
    const rows = await READDIR(accessor, spec('/'))
    expect(rows).toEqual([new FileStat({ name: 'rooms', type: FileType.DIRECTORY })])
    expect(accessor.calls).toEqual([])
  })

  it("answers a lister's children as stat does", async () => {
    expect(names(await READDIR(new FakeAccessor(), spec('/rooms')))).toEqual(['red', 'blue'])
  })

  it('renders a listed leaf as its scope filetype', async () => {
    // The lister left the note untyped; its scope says JSON, which is what
    // stat answered for it.
    const rows = rowsOf(await READDIR(new FakeAccessor(), spec('/rooms/red')))
    expect(rows.map((r) => [r.name, r.content, r.size])).toEqual([
      ['a.json', ContentType.JSON, 7],
      ['b.json', ContentType.JSON, 7],
    ])
  })

  it('rides extras on each listed row', async () => {
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: listRooms },
      staticRoot: ['rooms'],
      extras: { room: (match) => ({ room: match.slots.room ?? '' }) },
    })
    const rows = rowsOf(await readdir(new FakeAccessor(), spec('/rooms')))
    expect(rows.map((row) => row.extra)).toEqual([
      { room_id: 'red', room: 'red' },
      { room_id: 'blue', room: 'blue' },
    ])
  })

  it('runs the guard before the lister', async () => {
    const accessor = new FakeAccessor()
    await READDIR(accessor, spec('/rooms/red'))
    expect(accessor.calls).toEqual(['guard:red', 'notes:red'])
  })

  it('turns a guard failure into ENOENT even for a listable shape', async () => {
    await expect(READDIR(new FakeAccessor(), spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses leaf and invalid paths', async () => {
    const accessor = new FakeAccessor()
    await expect(READDIR(accessor, spec('/rooms/red/a.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(READDIR(accessor, spec('/halls'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops dot-prefixed names from listings', async () => {
    // The classifier refuses every dot-leading segment, so a listing must
    // not advertise one (a quoted postgres schema can be named ".foo"; every
    // other op would report it absent).
    const hiddenRooms: Lister<FakeAccessor> = async (accessor, match) => {
      const rooms = rowsOf((await listRooms(accessor, match)) ?? [])
      return [new FileStat({ name: '.secret', type: FileType.DIRECTORY }), ...rooms]
    }
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: hiddenRooms },
      staticRoot: ['rooms'],
    })
    expect(names(await readdir(new FakeAccessor(), spec('/rooms')))).toEqual(['red', 'blue'])
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
  accessor.calls.push(`entry-notes:${String(entry.extra.room_id)}`)
  const size = entry.extra.json_size
  return Promise.resolve([
    new FileStat({
      name: 'note.json',
      type: FileType.FILE,
      size: typeof size === 'number' ? size : null,
    }),
  ])
}

const ENTRY_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  entryListers: { room: entryNotes },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir entry listers', () => {
  it("hands an entry lister the directory's row", async () => {
    const accessor = new FakeAccessor()
    const row = new FileStat({
      name: 'red',
      type: FileType.DIRECTORY,
      extra: { room_id: 'red', json_size: 11 },
    })
    const rows = rowsOf(await ENTRY_READDIR(accessor, spec('/rooms/red'), row))
    expect(rows.map((r) => [r.name, r.size])).toEqual([['note.json', 11]])
    expect(accessor.calls).toEqual(['entry-notes:red'])
  })

  it('is ENOENT for an entry lister with no row', async () => {
    const accessor = new FakeAccessor()
    await expect(ENTRY_READDIR(accessor, spec('/rooms/ghost'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(accessor.calls).toEqual([])
  })

  it('refuses a kind named in both lister tables at build', () => {
    expect(() =>
      makeReaddir<FakeAccessor>(detectScope, {
        listers: { room: listNotes },
        entryListers: { room: entryNotes },
      }),
    ).toThrow()
  })
})

const dayLister: EntryLister<FakeAccessor> = (accessor, match, parent) => {
  accessor.calls.push(`day:${String(parent.extra.room_id)}:${match.slots.day ?? ''}`)
  return Promise.resolve([new FileStat({ name: 'atts', type: FileType.DIRECTORY })])
}

const PARENT_READDIR = makeReaddir<FakeAccessor>(detectScope, {
  listers: { rooms: listRooms },
  parentEntryListers: { room_day: dayLister },
  staticRoot: ['rooms'],
})

describe('hierarchy makeReaddir parent-entry listers', () => {
  it("is proven by the parent's row", async () => {
    const accessor = new FakeAccessor()
    const room = new FileStat({ name: 'red', type: FileType.DIRECTORY, extra: { room_id: 'r' } })
    const rows = await PARENT_READDIR(accessor, spec('/rooms/red/2026-01-05'), null, room)
    expect(names(rows)).toEqual(['atts'])
    expect(accessor.calls).toEqual(['day:r:2026-01-05'])
  })

  it('is ENOENT with no parent', async () => {
    await expect(
      PARENT_READDIR(new FakeAccessor(), spec('/rooms/ghost/2026-01-05')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a kind named in several lister tables at build', () => {
    expect(() =>
      makeReaddir<FakeAccessor>(detectScope, {
        listers: { rooms: listRooms },
        entryListers: { room_day: dayLister },
        parentEntryListers: { room_day: dayLister },
      }),
    ).toThrow()
  })
})

const seedingRooms: Lister<FakeAccessor> = (accessor, _match) => {
  accessor.calls.push('rooms')
  return Promise.resolve(
    new DirListing({
      entries: [new FileStat({ name: 'red', type: FileType.DIRECTORY })],
      seeds: new Map([
        [
          'red',
          [
            new FileStat({ name: 'a.json', type: FileType.FILE }),
            new FileStat({ name: '.hidden.json', type: FileType.FILE }),
          ],
        ],
      ]),
      window: true,
    }),
  )
}

function globbed(mountPath: string, pattern: string): PathSpec {
  const base = spec(mountPath)
  return new PathSpec({
    virtual: `${base.virtual}/${pattern}`,
    directory: `${base.virtual}/`,
    vfsPath: `${base.vfsPath}/${pattern}`,
    pattern,
  })
}

describe('hierarchy makeReaddir listings', () => {
  it('finishes seeds like the listing', async () => {
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { rooms: seedingRooms },
      staticRoot: ['rooms'],
    })
    const listed = await readdir(new FakeAccessor(), spec('/rooms'))
    expect(listed).toBeInstanceOf(DirListing)
    const listing = listed as DirListing
    expect(listing.window).toBe(true)
    expect(names(listing)).toEqual(['red'])
    expect((listing.seeds.get('red') ?? []).map((r) => [r.name, r.content])).toEqual([
      ['a.json', ContentType.JSON],
    ])
  })

  it("hands the glob to a pattern kind's lister", async () => {
    const accessor = new FakeAccessor()
    const days: Lister<FakeAccessor> = (a, match) => {
      a.calls.push(`days:${String(match.pattern)}`)
      return Promise.resolve(
        new DirListing({
          entries: [new FileStat({ name: '2026-01-05', type: FileType.DIRECTORY })],
          window: true,
        }),
      )
    }
    const readdir = makeReaddir<FakeAccessor>(detectScope, {
      listers: { room: days },
      patternKinds: { room: (pattern) => pattern.startsWith('2026') },
    })
    await readdir(accessor, globbed('/rooms/red', '2026-*'))
    await readdir(accessor, globbed('/rooms/red', '*.json'))
    expect(accessor.calls).toEqual(['days:2026-*', 'days:null'])
  })
})

// Twin of test_a_walks_limit_reaches_the_lister_on_its_match.
it('hands a walk limit to the lister on its match', async () => {
  const seen: (number | undefined)[] = []
  const rooms: Lister<FakeAccessor> = (_accessor, match) => {
    seen.push(match.limit)
    return Promise.resolve([])
  }
  const readdir = makeReaddir<FakeAccessor>(detectScope, { listers: { rooms } })
  await readdir(new FakeAccessor(), spec('/rooms'), null, null, 3)
  await readdir(new FakeAccessor(), spec('/rooms'))
  expect(seen).toEqual([3, undefined])
})

// Twin of test_held_pages_stops_at_the_page_that_brings_the_limit.
it('holds no page past the one that brings the limit', async () => {
  const pulled: number[] = []
  const closed: boolean[] = []
  async function* pages(): AsyncGenerator<number[]> {
    try {
      for (const page of [[1, 2], [3, 4], [5]]) {
        pulled.push(page[0] ?? 0)
        yield await Promise.resolve(page)
      }
    } finally {
      closed.push(true)
    }
  }
  expect(await heldPages(pages(), 3)).toEqual([1, 2, 3, 4])
  expect([pulled, closed]).toEqual([[1, 3], [true]])
  expect(await heldPages(pages(), undefined)).toEqual([1, 2, 3, 4, 5])
})

// Twin of test_cut_listing_is_partial_once_the_rows_reach_the_limit.
it('cuts a listing once its rows reach the limit', () => {
  const rows = ['a', 'b'].map((name) => new FileStat({ name, type: FileType.FILE }))
  const cut = cutListing(rows, 2)
  expect(cut instanceof DirListing && cut.partial).toBe(true)
  expect(cutListing(rows, 3)).toBe(rows)
  expect(cutListing(rows, undefined)).toBe(rows)
})
