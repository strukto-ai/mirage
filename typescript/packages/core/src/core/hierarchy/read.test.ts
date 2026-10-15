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
import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { Codec, DATE, JSON_NAME } from './codec.ts'
import {
  makeRead,
  makeReadRange,
  perKind,
  type Guard,
  type RangedReader,
  type Reader,
  type WindowedReader,
} from './read.ts'
import { Slot, Scope, makeDetectScope, type ScopeMatch } from './scope.ts'

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

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

const readNote: Reader<FakeAccessor> = (_accessor, match) =>
  Promise.resolve(ENCODER.encode(`${match.slots.room ?? ''}:${match.slots.note ?? ''}`))

const readNoteWindow: WindowedReader<FakeAccessor> = (
  _accessor,
  match,
  _path,
  _entry,
  _parent,
  window,
) =>
  Promise.resolve(
    ENCODER.encode(
      `${match.slots.note ?? ''}:${String(window.limit ?? null)}:${String(window.offset ?? null)}`,
    ),
  )

const READ = makeRead<FakeAccessor>(detectScope, { note: readNote })

describe('hierarchy makeRead', () => {
  it('hands the reader the slots', async () => {
    const out = await READ(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(DECODER.decode(out)).toBe('red:a')
  })

  it('answers directories that exist by construction with EISDIR', async () => {
    // The root and a probed=false scope provably exist, so reading one as a
    // file is EISDIR rather than absent.
    for (const path of ['/', '/rooms']) {
      await expect(READ(new FakeAccessor(), spec(path))).rejects.toMatchObject({ code: 'EISDIR' })
    }
  })

  it('answers everything else with ENOENT', async () => {
    // A probed directory shape is no proof the node exists, so a read there
    // reports absence, matching GNU's wording for a missing name.
    for (const path of ['/rooms/red', '/rooms/.red/a.json', '/halls']) {
      await expect(READ(new FakeAccessor(), spec(path))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('hands a windowed reader the window', async () => {
    const read = makeRead<FakeAccessor>(detectScope, {}, { windowed: { note: readNoteWindow } })
    const path = spec('/rooms/red/a.json')
    const out = await read(new FakeAccessor(), path, null, null, { limit: 5, offset: 2 })
    expect(DECODER.decode(out)).toBe('a:5:2')
    expect(DECODER.decode(await read(new FakeAccessor(), path))).toBe('a:null:null')
  })

  it('lets a plain reader ignore the window', async () => {
    const out = await READ(new FakeAccessor(), spec('/rooms/red/a.json'), null, null, { limit: 3 })
    expect(DECODER.decode(out)).toBe('red:a')
  })
})

const PROVEN_READ = makeRead<FakeAccessor>(detectScope, { note: readNote }, { parented: true })

describe('hierarchy makeRead parented', () => {
  it('proves its parent by its row', async () => {
    // No listing names "green": the read is ENOENT for the file itself, and
    // its reader never runs.
    await expect(
      PROVEN_READ(new FakeAccessor(), spec('/rooms/green/a.json')),
    ).rejects.toMatchObject({ code: 'ENOENT', virtualPath: '/h/rooms/green/a.json' })
    const room = new FileStat({ name: 'red', type: FileType.DIRECTORY })
    const out = await PROVEN_READ(new FakeAccessor(), spec('/rooms/red/z.json'), null, room)
    // The parent is proven; the file stays the reader's to prove.
    expect(DECODER.decode(out)).toBe('red:z')
  })

  it('trusts the path when it proves no parent', async () => {
    const accessor = new FakeAccessor()
    expect(DECODER.decode(await READ(accessor, spec('/rooms/green/a.json')))).toBe('green:a')
    expect(accessor.calls).toEqual([])
  })
})

const readNoteRange: RangedReader<FakeAccessor> = (
  _accessor,
  match,
  _path,
  _entry,
  _parent,
  offset,
  size,
) =>
  Promise.resolve(
    ENCODER.encode(`ranged:${match.slots.note ?? ''}:${String(offset)}:${String(size)}`),
  )

const READ_RANGE = makeReadRange<FakeAccessor>(detectScope, READ, { tagged: readNoteRange })

describe('hierarchy makeReadRange', () => {
  it('pushes the window to a ranged reader', async () => {
    const ranged = makeReadRange<FakeAccessor>(detectScope, READ, { note: readNoteRange })
    const path = spec('/rooms/red/a.json')
    const out = await ranged(new FakeAccessor(), path, null, null, { offset: 2, size: 5 })
    expect(DECODER.decode(out)).toBe('ranged:a:2:5')
  })

  it('slices the full read for an unranged kind', async () => {
    const path = spec('/rooms/red/a.json')
    const out = await READ_RANGE(new FakeAccessor(), path, null, null, { offset: 1, size: 3 })
    // The full read rendered "red:a"; the window is taken after the fact.
    expect(DECODER.decode(out)).toBe('ed:')
  })

  it('defaults to the whole file', async () => {
    const out = await READ_RANGE(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(DECODER.decode(out)).toBe('red:a')
  })
})

const noteLines = (_accessor: FakeAccessor, match: ScopeMatch, _path: PathSpec, n: number) =>
  Promise.resolve(ENCODER.encode(`${match.slots.note ?? ''}:${String(n)}`))

describe('hierarchy perKind', () => {
  it('answers its kinds after the guard', async () => {
    const guarded: string[] = []
    const guard: Guard<FakeAccessor> = (_accessor, _match, virtual) => {
      guarded.push(virtual)
      return Promise.resolve()
    }
    const first = perKind(detectScope, { note: noteLines }, { guard })
    const out = await first(new FakeAccessor(), spec('/rooms/red/a.json'), 3)
    expect(DECODER.decode(out ?? new Uint8Array())).toBe('a:3')
    expect(guarded).toEqual(['/h/rooms/red/a.json'])
  })

  it('is null for any other kind without the guard', async () => {
    const guard: Guard<FakeAccessor> = () =>
      Promise.reject(new Error('no guard for a kind with no answer'))
    const first = perKind(detectScope, { note: noteLines }, { guard })
    expect(await first(new FakeAccessor(), spec('/rooms/red'), 3)).toBeNull()
  })

  it('raises what the guard raises', async () => {
    const guard: Guard<FakeAccessor> = (_accessor, _match, virtual) =>
      Promise.reject(enoent(virtual))
    const first = perKind(detectScope, { note: noteLines }, { guard })
    await expect(first(new FakeAccessor(), spec('/rooms/red/a.json'), 3)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
