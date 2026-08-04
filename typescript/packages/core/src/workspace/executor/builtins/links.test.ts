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

import { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { resolvePathStat } from './links.ts'
import type { DispatchFn } from '../cross_mount.ts'

/** Fake op dispatcher answering stat and readdir independently. */
function dispatcher(
  statAnswer: FileStat | Error,
  readdirAnswer: string[] | Error,
): { fn: DispatchFn; ops: string[] } {
  const ops: string[] = []
  const fn = ((op: string, _scope: PathSpec): Promise<[unknown, IOResult]> => {
    ops.push(op)
    const answer = op === 'stat' ? statAnswer : readdirAnswer
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve([answer, new IOResult()])
  }) as unknown as DispatchFn
  return { fn, ops }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: '' })
}

function enoent(path: string): Error {
  return Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' })
}

describe('resolvePathStat', () => {
  it('answers from stat alone when the backend can see the path', async () => {
    const stat = new FileStat({ name: 'sub', type: FileType.DIRECTORY })
    const { fn, ops } = dispatcher(stat, new Error('readdir must not be reached'))
    expect(await resolvePathStat(fn, spec('/data/sub'))).toBe(stat)
    expect(ops).toEqual(['stat'])
  })

  // On a prefix store a directory is not an object, so the point lookup
  // misses what the listing would show. Measured on every integ target: s3,
  // gridfs, hf, nextcloud and the Graph backends all answer here.
  it('resolves an implicit directory through readdir', async () => {
    const { fn, ops } = dispatcher(enoent('/data/sub'), ['/data/sub/a.txt'])
    const stat = await resolvePathStat(fn, spec('/data/sub'))
    expect(stat?.type).toBe(FileType.DIRECTORY)
    expect(stat?.name).toBe('sub')
    expect(ops).toEqual(['stat', 'readdir'])
  })

  // A prefix store answers a missing path with an empty listing rather than
  // raising, so the listing being empty is what separates absence from an
  // implicit directory.
  it('reports absence only when both channels come back empty', async () => {
    const { fn } = dispatcher(enoent('/data/nope'), [])
    expect(await resolvePathStat(fn, spec('/data/nope'))).toBeNull()
  })

  it('treats a raising readdir as absence too', async () => {
    const { fn } = dispatcher(enoent('/data/nope'), enoent('/data/nope'))
    expect(await resolvePathStat(fn, spec('/data/nope'))).toBeNull()
  })

  // Mapping a permission or capability failure to "not there" would report a
  // path that exists as missing, so it propagates instead.
  it('does not read a permission error as absence', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const { fn } = dispatcher(denied, [])
    await expect(resolvePathStat(fn, spec('/data/locked'))).rejects.toThrow('permission denied')
  })
})
