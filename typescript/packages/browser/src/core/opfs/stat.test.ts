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
import { FileType } from '@struktoai/mirage-core'
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { mkdir } from './mkdir.ts'
import { stat } from './stat.ts'
import { writeBytes } from './write.ts'

describe('opfs/stat', () => {
  it('returns FileStat with size for files', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/x'), new TextEncoder().encode('abc'))
    const s = await stat(accessor, spec('/x'))
    expect(s.size).toBe(3)
    expect(s.type).not.toBe(FileType.DIRECTORY)
  })
  it('returns DIRECTORY type for directories', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    const s = await stat(accessor, spec('/d'))
    expect(s.type).toBe(FileType.DIRECTORY)
  })
  it('derives directory mtime from the newest file child', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/d'))
    await writeBytes(accessor, spec('/d/a'), new TextEncoder().encode('a'))
    const child = await stat(accessor, spec('/d/a'))
    const dir = await stat(accessor, spec('/d'))
    expect(dir.type).toBe(FileType.DIRECTORY)
    expect(dir.modified).not.toBeNull()
    expect(dir.modified).toBe(child.modified)
  })
  it('leaves directory mtime null when it has no files', async () => {
    const accessor = makeMockAccessor()
    await mkdir(accessor, spec('/empty'))
    const s = await stat(accessor, spec('/empty'))
    expect(s.modified).toBeNull()
  })
  it('throws on missing path', async () => {
    const accessor = makeMockAccessor()
    await expect(stat(accessor, spec('/nope'))).rejects.toThrow()
  })
})
