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
import { ContentType, PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { JSON_NAME } from './codec.ts'
import {
  makeRead,
  makeReadRange,
  type RangedReader,
  type Reader,
  type WindowedReader,
} from './read.ts'
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

const readNote: Reader<FakeAccessor> = (_accessor, match, _path, _index) =>
  Promise.resolve(new TextEncoder().encode(`${match.slots.room ?? ''}:${match.slots.note ?? ''}`))

const READ = makeRead<FakeAccessor>(detectScope, { note: readNote })

describe('hierarchy makeRead', () => {
  it('hands the reader the slots', async () => {
    const out = await READ(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(new TextDecoder().decode(out)).toBe('red:a')
  })

  it('answers directories that exist by construction with EISDIR', async () => {
    // The root and a probed=false scope provably exist, so reading one
    // as a file is EISDIR rather than absent.
    for (const path of ['/', '/rooms']) {
      await expect(READ(new FakeAccessor(), spec(path))).rejects.toMatchObject({
        code: 'EISDIR',
      })
    }
  })

  it('answers everything else with ENOENT', async () => {
    // A probed directory shape is no proof the node exists, so a read
    // there reports absence, matching GNU's wording for a missing name.
    for (const path of ['/rooms/red', '/rooms/.red/a.json', '/halls']) {
      await expect(READ(new FakeAccessor(), spec(path))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  })

  it('hands a windowed reader the window', async () => {
    const readWindowed: WindowedReader<FakeAccessor> = (_accessor, match, _path, _index, window) =>
      Promise.resolve(
        new TextEncoder().encode(
          `${match.slots.note ?? ''}:${String(window.limit ?? null)}:${String(window.offset ?? null)}`,
        ),
      )
    const read = makeRead<FakeAccessor>(detectScope, {}, { note: readWindowed })
    let out = await read(new FakeAccessor(), spec('/rooms/red/a.json'), undefined, {
      limit: 5,
      offset: 2,
    })
    expect(new TextDecoder().decode(out)).toBe('a:5:2')
    out = await read(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(new TextDecoder().decode(out)).toBe('a:null:null')
  })

  it('lets a plain reader ignore the window', async () => {
    const out = await READ(new FakeAccessor(), spec('/rooms/red/a.json'), undefined, { limit: 3 })
    expect(new TextDecoder().decode(out)).toBe('red:a')
  })
})

const readNoteRange: RangedReader<FakeAccessor> = (_accessor, match, _path, _index, offset, size) =>
  Promise.resolve(
    new TextEncoder().encode(`ranged:${match.slots.note ?? ''}:${String(offset)}:${String(size)}`),
  )

describe('hierarchy makeReadRange', () => {
  it('pushes the window to a ranged reader', async () => {
    const readRange = makeReadRange<FakeAccessor>(detectScope, READ, { note: readNoteRange })
    const out = await readRange(new FakeAccessor(), spec('/rooms/red/a.json'), undefined, {
      offset: 2,
      size: 5,
    })
    expect(new TextDecoder().decode(out)).toBe('ranged:a:2:5')
  })

  it('slices the full read for an unranged kind', async () => {
    const readRange = makeReadRange<FakeAccessor>(detectScope, READ, {})
    const out = await readRange(new FakeAccessor(), spec('/rooms/red/a.json'), undefined, {
      offset: 1,
      size: 3,
    })
    // The full read rendered "red:a"; the window is taken after the fact.
    expect(new TextDecoder().decode(out)).toBe('ed:')
  })

  it('defaults to the whole file', async () => {
    const readRange = makeReadRange<FakeAccessor>(detectScope, READ, {})
    const out = await readRange(new FakeAccessor(), spec('/rooms/red/a.json'))
    expect(new TextDecoder().decode(out)).toBe('red:a')
  })
})
