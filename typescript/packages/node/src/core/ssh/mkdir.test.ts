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

import type { Stats } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { makeFakeAccessor } from '../../../tests/core/ssh/_test_utils.ts'
import { mkdir } from './mkdir.ts'
import { stat } from './stat.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/mkdir', () => {
  it('creates a single directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/d'), false)
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('creates parents when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await mkdir(accessor, spec('/a/b/c'), true)
    expect((await stat(accessor, spec('/a'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/a/b/c'))).type).toBe(FileType.DIRECTORY)
  })

  it('is idempotent on existing directory when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/d', {}],
      ]),
    })
    await expect(mkdir(accessor, spec('/d'), true)).resolves.toBeUndefined()
  })

  it('passes a server-side link to a directory when recursive', async () => {
    const state = {
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/lnk', {}],
      ]),
    }
    const accessor = makeFakeAccessor(state)
    Object.assign(await accessor.sftp(), {
      lstat(_path: string, cb: (err: Error | undefined, stats: Stats) => void): void {
        cb(undefined, { isDirectory: () => false, isSymbolicLink: () => true } as Stats)
      },
    })
    await mkdir(accessor, spec('/lnk/new'), true)
    expect(state.dirs.has('/lnk/new')).toBe(true)
  })

  it('names a file in the way as ENOTDIR when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/f', { data: new Uint8Array() }]]),
      dirs: new Map([['/', {}]]),
    })
    await expect(mkdir(accessor, spec('/f/x'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
      message: '/f',
    })
  })

  it('names a refused step as EACCES when recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/locked', {}],
      ]),
    })
    Object.assign(await accessor.sftp(), {
      mkdir(_path: string, cb: (err: Error) => void): void {
        cb(Object.assign(new Error('Permission denied'), { code: 3 }))
      },
    })
    await expect(mkdir(accessor, spec('/locked/new'), true)).rejects.toMatchObject({
      code: 'EACCES',
      message: '/locked/new',
    })
  })

  it('fails when parent missing and not recursive', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(mkdir(accessor, spec('/a/b'), false)).rejects.toThrow()
  })
})
