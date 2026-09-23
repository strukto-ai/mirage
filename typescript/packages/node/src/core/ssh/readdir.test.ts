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
import { PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { makeFakeAccessor } from './_test_utils.ts'
import { readdir } from './readdir.ts'

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/readdir', () => {
  it('returns sorted virtual paths under a directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/data/b.txt', { data: new Uint8Array() }],
        ['/data/a.txt', { data: new Uint8Array() }],
      ]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const out = await readdir(accessor, spec('/data'))
    expect(out).toEqual(['/data/a.txt', '/data/b.txt'])
  })

  it('throws ENOENT for a missing directory', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    await expect(readdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOTDIR for an operand under a file', async () => {
    // SFTP 3 answers `/a.txt/x` with NO_SUCH_FILE exactly as it does a name
    // that is simply absent, so only the ancestor walk can tell GNU's "Not a
    // directory" from "No such file or directory".
    const accessor = makeFakeAccessor({
      files: new Map([['/a.txt', { data: new Uint8Array() }]]),
      dirs: new Map([['/', {}]]),
    })
    await expect(readdir(accessor, spec('/a.txt/x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(readdir(accessor, spec('/nope/deeper'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('preserves the mount prefix in returned paths', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/data/a.txt', { data: new Uint8Array() }]]),
      dirs: new Map([
        ['/', {}],
        ['/data', {}],
      ]),
    })
    const p = new PathSpec({
      virtual: '/mnt/ssh/data',
      directory: '/mnt/ssh/data',
      vfsPath: mountKey('/mnt/ssh/data', '/mnt/ssh'),
    })
    const out = await readdir(accessor, p)
    expect(out).toEqual(['/mnt/ssh/data/a.txt'])
  })
})
