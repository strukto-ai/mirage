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
import { read } from '../../core/document/read.ts'
import { readdir } from '../../core/document/readdir.ts'
import { stat } from '../../core/document/stat.ts'
import { FileType, PathSpec } from '../../types.ts'
import { DocumentVFS } from './document.ts'

const ROOT = new PathSpec({ virtual: '/VFS.md', directory: '/', vfsPath: '' })
const DEC = new TextDecoder()

function vfs(text: { value: string }): DocumentVFS {
  return new DocumentVFS('VFS.md', () => text.value, 'vfs')
}

describe('DocumentVFS', () => {
  it('renders again on every read', async () => {
    const text = { value: 'first\n' }
    const doc = vfs(text)
    expect(DEC.decode(await read(doc.accessor, ROOT))).toBe('first\n')
    text.value = 'second\n'
    expect(DEC.decode(await read(doc.accessor, ROOT))).toBe('second\n')
  })

  it('stats the rendered byte length', async () => {
    const doc = vfs({ value: 'café\n' })
    const st = await stat(doc.accessor, ROOT)
    expect([st.name, st.type, st.size]).toEqual(['VFS.md', FileType.FILE, 6])
    expect(doc.sizesAlwaysKnown).toBe(true)
  })

  it('holds nothing below the file', async () => {
    const doc = vfs({ value: 'x' })
    const below = new PathSpec({ virtual: '/VFS.md/a', directory: '/VFS.md', vfsPath: 'a' })
    await expect(read(doc.accessor, below)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(doc.accessor, ROOT)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
