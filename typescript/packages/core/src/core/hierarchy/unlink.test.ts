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

const remove: DeleteFn<FakeAccessor> = (accessor, _match, entry) => {
  accessor.calls.push(`delete:${entry.name}`)
  return Promise.resolve()
}

const UNLINK = makeUnlink<FakeAccessor>(detectScope, { deleters: { note: remove } })
const NOTE = new FileStat({ name: 'a.json', type: FileType.FILE })

describe('hierarchy makeUnlink', () => {
  it('deletes the row it is handed', async () => {
    const accessor = new FakeAccessor()
    await UNLINK(accessor, spec('/rooms/red/a.json'), NOTE)
    expect(accessor.calls).toEqual(['delete:a.json'])
  })

  it('refuses a directory', async () => {
    const accessor = new FakeAccessor()
    await expect(UNLINK(accessor, spec('/rooms/red'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(UNLINK(accessor, spec('/'))).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('is ENOENT for a path no listing names', async () => {
    const accessor = new FakeAccessor()
    const path = spec('/rooms/red/nope.json')
    await expect(UNLINK(accessor, path)).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: path.virtual,
    })
    await expect(UNLINK(accessor, spec('/halls/x.json'), NOTE)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(accessor.calls).toEqual([])
  })
})
