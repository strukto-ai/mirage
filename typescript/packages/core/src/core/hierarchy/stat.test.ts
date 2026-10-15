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
import type { ExtraFn, Guard } from './readdir.ts'
import { Slot, Scope, makeDetectScope } from './scope.ts'
import { entryStat, makeStat, type StatHook } from './stat.ts'

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

const roomGuard: Guard<FakeAccessor> = (accessor, match, virtual) => {
  const room = match.slots.room ?? ''
  accessor.calls.push(`guard:${room}`)
  if (!(TREE.rooms ?? []).includes(room)) return Promise.reject(enoent(virtual))
  return Promise.resolve()
}

const roomExtra: ExtraFn = (match) => ({ room: match.slots.room ?? '' })

const STAT = makeStat<FakeAccessor>(detectScope, {
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

  it('answers a listed row without its guard', async () => {
    const accessor = new FakeAccessor()
    const row = new FileStat({ name: 'red', type: FileType.DIRECTORY, extra: { room: 'red' } })
    expect(await STAT(accessor, spec('/rooms/red'), row)).toBe(row)
    expect(accessor.calls).toEqual([])
  })

  it('carries extras on a guarded dir no listing names', async () => {
    const accessor = new FakeAccessor()
    const st = await STAT(accessor, spec('/rooms/red'))
    expect(st.type).toBe(FileType.DIRECTORY)
    expect(st.extra).toEqual({ room: 'red' })
    expect(accessor.calls).toEqual(['guard:red'])
  })

  it('is ENOENT for a probed leaf no listing names', async () => {
    await expect(STAT(new FakeAccessor(), spec('/rooms/red/nope.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('is ENOENT for invalid shapes', async () => {
    const accessor = new FakeAccessor()
    await expect(STAT(accessor, spec('/halls'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(STAT(accessor, spec('/rooms/.red'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets an override replace the whole answer', async () => {
    const accessor = new FakeAccessor()
    const bespoke: StatHook<FakeAccessor> = (_accessor, _match, _path, _entry, parent) =>
      Promise.resolve(
        new FileStat({
          name: 'custom',
          type: FileType.FILE,
          content: ContentType.TEXT,
          size: parent === null ? null : 1,
        }),
      )
    const stat = makeStat<FakeAccessor>(detectScope, { overrides: { note: bespoke } })
    const room = new FileStat({ name: 'red', type: FileType.DIRECTORY })
    const st = await stat(accessor, spec('/rooms/red/a.json'), null, room)
    expect([st.name, st.size]).toEqual(['custom', 1])
    expect(accessor.calls).toEqual([])
  })
})

describe('hierarchy entryStat', () => {
  it.each([
    [FileType.DIRECTORY, FileType.DIRECTORY, null],
    [ContentType.JSON, FileType.FILE, ContentType.JSON],
    [undefined, FileType.FILE, ContentType.TEXT],
  ] as const)('builds the row a listing names for %s', (kind, type, content) => {
    const build = entryStat('doc_id', kind)
    const row = build('a.txt', 'D1', { size: 7, modified: '', extra: { kept: 1 } })
    expect([row.name, row.type, row.content, row.size]).toEqual(['a.txt', type, content, 7])
    expect(row.modified).toBeNull()
    expect(row.extra).toEqual({ kept: 1, doc_id: 'D1' })
  })
})
