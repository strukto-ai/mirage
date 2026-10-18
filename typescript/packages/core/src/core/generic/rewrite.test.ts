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

import { describe, expect, it, vi } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { appendByRewrite, truncateByRewrite } from './rewrite.ts'

const PATH = PathSpec.fromStrPath('/m/f')

describe('appendByRewrite', () => {
  it.each([
    [true, 'new'],
    [false, 'new'],
    [false, ''],
    [true, ''],
  ] as const)('returns confirmed write metadata, existing %s, data %j', async (existing, data) => {
    const row = new FileStat({ name: 'f', type: FileType.FILE })
    const read = () =>
      existing ? Promise.resolve(new TextEncoder().encode('old')) : Promise.reject(enoent(PATH))
    const stat = () => (existing ? Promise.resolve(row) : Promise.reject(enoent(PATH)))
    const write = () => Promise.resolve(row)
    const result = await appendByRewrite(read, write, stat, PATH, new TextEncoder().encode(data))
    expect(result).toEqual(existing && data === '' ? undefined : row)
  })
})

describe('truncateByRewrite', () => {
  it('refuses a negative length before any io', async () => {
    const read = vi.fn()
    const write = vi.fn()
    await expect(truncateByRewrite(read, write, PATH, -1, false)).rejects.toMatchObject({
      code: 'EINVAL',
    })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
