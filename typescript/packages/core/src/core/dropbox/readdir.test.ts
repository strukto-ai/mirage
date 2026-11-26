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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PathsModule from './paths.ts'

// The real spelling check, but for the one test that sets it aside.
vi.mock('./paths.ts', async (original) => {
  const actual = await original<typeof PathsModule>()
  return { ...actual, checkPath: vi.fn(actual.checkPath) }
})

import { mountKey } from '../../utils/key_prefix.ts'
import { type FileStat, FileType, PathSpec } from '../../types.ts'
import { DropboxAccount } from '../../../tests/core/dropbox/account.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { checkPath } from './paths.ts'
import { readdir } from './readdir.ts'

const ENC = new TextEncoder()
const ROOT = new PathSpec({ vfsPath: '', virtual: '/', directory: '/' })

let origin: string
let account: DropboxAccount

// Past the 20 s the fixture gives the fake to start, so a slow start fails
// with the fixture's message, not the hook's.
beforeAll(async () => {
  origin = await serve('dropbox')
}, 30_000)

beforeEach(() => {
  vi.mocked(checkPath).mockClear()
  account = new DropboxAccount(origin)
})

afterEach(async () => {
  await account.run.close()
})

function spec(virtual: string): PathSpec {
  return new PathSpec({ vfsPath: virtual.replace(/^\/+/, ''), virtual, directory: virtual })
}

async function rows(path: PathSpec, rootPath?: string): Promise<FileStat[]> {
  return (await readdir(account.accessor(rootPath), path)) as FileStat[]
}

describe('dropbox readdir', () => {
  it('lists root entries with file/folder distinction', async () => {
    await account.mkdir('/docs')
    await account.put('/notes.txt', new Uint8Array(42))
    await account.run.recordRequests()
    const out = await rows(ROOT)
    expect(out.map((row) => [row.name, row.type])).toEqual([
      ['docs', FileType.DIRECTORY],
      ['notes.txt', FileType.FILE],
    ])
    expect(out[1]?.size).toBe(42)
    const listed = await account.run.bodies('POST', '/2/files/list_folder')
    expect(listed.map((body) => (body as { path: string }).path)).toEqual([''])
  })

  it('lists a nested subfolder by its path', async () => {
    await account.put('/docs/note.md', new Uint8Array(12))
    expect((await rows(spec('/docs'))).map((row) => row.name)).toEqual(['note.md'])
  })

  it('scopes listings under a subfolder mount root', async () => {
    await account.put('/Team/data/docs/note.md', new Uint8Array(12))
    await account.put('/Team/other.txt', new Uint8Array(1))
    expect((await rows(ROOT, '/Team/data')).map((row) => row.name)).toEqual(['docs'])
    expect((await rows(spec('/docs'), '/Team/data')).map((row) => row.name)).toEqual(['note.md'])
  })

  it('honors prefix when constructing virtual path', async () => {
    await account.put('/a.txt', new Uint8Array(1))
    const path = new PathSpec({
      virtual: '/dropbox',
      directory: '/dropbox',
      vfsPath: mountKey('/dropbox', '/dropbox'),
    })
    expect((await rows(path)).map((row) => row.name)).toEqual(['a.txt'])
  })

  it('reports ENOENT for a missing folder', async () => {
    await expect(rows(spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports ENOTDIR for an operand under a file', async () => {
    // list_folder answers path/not_found for `/a.txt/x` exactly as it does
    // for a name that is simply absent, so only the ancestor walk can tell
    // GNU's "Not a directory" from "No such file or directory".
    await account.put('/a.txt', ENC.encode('a'))
    await expect(rows(spec('/a.txt/x'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  // The operand is itself a file, so the shortcut settles it: one metadata
  // call, none for the ancestors above it. The spelling check, tested on its
  // own, would walk them first, so it is set aside.
  it('reports ENOTDIR on a file without walking', async () => {
    await account.put('/docs/a.txt', ENC.encode('a'))
    vi.mocked(checkPath).mockResolvedValueOnce(null)
    await account.run.recordRequests()
    await expect(rows(spec('/docs/a.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    const asked = await account.run.bodies('POST', '/2/files/get_metadata')
    expect(asked.map((body) => (body as { path: string }).path)).toEqual(['/docs/a.txt'])
  })

  it('reports ENOENT for a path no component of which exists', async () => {
    await expect(rows(spec('/nope/deeper'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps 0-byte files with size 0', async () => {
    await account.put('/empty.txt', new Uint8Array(0))
    expect((await rows(ROOT)).map((row) => [row.name, row.size])).toEqual([['empty.txt', 0]])
  })
})
