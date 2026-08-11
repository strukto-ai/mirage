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
import { exists } from './exists.ts'
import { mkdir } from './mkdir.ts'
import { read } from './read.ts'
import { writeBytes } from './write.ts'

describe('opfs/mkdir', () => {
  it('creates a single directory', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    expect(await exists(accessor, spec('/d'))).toBe(true)
  })
  it('throws when parent does not exist and parents=false', async () => {
    // A bare Error would not be classified as a filesystem failure, so the
    // command layer could not report it with a GNU strerror.
    const accessor = makeMockAccessor()
    await expect(mkdir(accessor, spec('/a/b'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is ENOTDIR when a parent component is a plain file', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/plain'), new TextEncoder().encode('y'))
    await expect(mkdir(accessor, spec('/plain/sub'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
  it('creates nested directories with parents=true', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/a/b/c'), true)
    expect(await exists(accessor, spec('/a/b/c'))).toBe(true)
  })
  it('refuses an existing directory without -p, and is a no-op with it (GNU)', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    await expect(mkdir(accessor, spec('/d'))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(mkdir(accessor, spec('/d'), true)).resolves.toBeUndefined()
  })

  it('-p across a plain file names the component and keeps the file', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/f.txt'), new TextEncoder().encode('hi'))
    await expect(mkdir(accessor, spec('/f.txt/sub'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/f.txt',
    })
    expect(new TextDecoder().decode(await read(accessor, spec('/f.txt')))).toBe('hi')
  })

  it('-p onto a plain file target is EEXIST', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/f.txt'), new TextEncoder().encode('hi'))
    await expect(mkdir(accessor, spec('/f.txt'), true)).rejects.toMatchObject({ code: 'EEXIST' })
  })
})
