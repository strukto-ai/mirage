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
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { mkdir } from './mkdir.ts'
import { readdir } from './readdir.ts'
import { writeBytes } from './write.ts'

describe('opfs/readdir', () => {
  it('lists entries with full virtual paths sorted', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/b'), new Uint8Array())
    await writeBytes(accessor, spec('/a'), new Uint8Array())
    expect(await readdir(accessor, spec('/'))).toEqual(['/a', '/b'])
  })
  it('lists nested directory', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/sub'))
    await writeBytes(accessor, spec('/sub/x'), new Uint8Array())
    expect(await readdir(accessor, spec('/sub'))).toEqual(['/sub/x'])
  })
  it('throws ENOENT for a missing path, at any depth', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/sub'))
    for (const p of ['/nope', '/sub/nope', '/nope/deeper']) {
      await expect(readdir(accessor, spec(p))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  it('throws ENOTDIR when a path component is a file', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/a.txt'), new Uint8Array())
    for (const p of ['/a.txt', '/a.txt/x', '/a.txt/x/y']) {
      await expect(readdir(accessor, spec(p))).rejects.toMatchObject({ code: 'ENOTDIR' })
    }
  })
})
