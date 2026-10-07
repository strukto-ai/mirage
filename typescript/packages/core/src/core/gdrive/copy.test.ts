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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ContextModule from '../../cache/context.ts'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

vi.mock('../../cache/context.ts', async () => {
  const actual = await vi.importActual<typeof ContextModule>('../../cache/context.ts')
  return {
    ...actual,
    invalidateAfterWrite: vi.fn(() => Promise.resolve()),
    invalidateSubtree: vi.fn(() => Promise.resolve()),
  }
})

import { invalidateAfterWrite, invalidateSubtree } from '../../cache/context.ts'
import { PathSpec } from '../../types.ts'
import type { FakeDrive } from './_test_util.ts'
import { makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'
import { copy } from './copy.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('gdrive copy', () => {
  it('copies a file', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('data'))
    await copy(accessor, spec('/src.txt'), spec('/dst.txt'))
    expect(DEC.decode(fake.find('dst.txt')?.content)).toBe('data')
    expect(fake.find('src.txt')).not.toBeNull()
  })

  it('overwrites an existing file', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('new'))
    fake.add('dst.txt', 'root', undefined, ENC.encode('old'))
    await copy(accessor, spec('/src.txt'), spec('/dst.txt'))
    expect(DEC.decode(fake.find('dst.txt')?.content)).toBe('new')
    expect(fake.items.size).toBe(2)
  })

  it('file onto dir raises EISDIR', async () => {
    fake.add('src.txt', 'root', undefined, ENC.encode('x'))
    fake.folder('d')
    await expect(copy(accessor, spec('/src.txt'), spec('/d'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('copies a tree into a missing dir', async () => {
    const src = fake.folder('src')
    const sub = fake.folder('sub', src)
    fake.add('f.txt', sub, undefined, ENC.encode('deep'))
    fake.add('top.txt', src, undefined, ENC.encode('top'))
    await copy(accessor, spec('/src'), spec('/dst'))
    expect(fake.find('dst')).not.toBeNull()
    for (const name of ['sub', 'f.txt', 'top.txt']) {
      const copies = [...fake.items.values()].filter((i) => i.name === name)
      expect(copies).toHaveLength(2)
    }
  })

  it('merges into an existing dir', async () => {
    const src = fake.folder('src')
    fake.add('f.txt', src, undefined, ENC.encode('x'))
    const dst = fake.folder('dst')
    fake.add('keep.txt', dst, undefined, ENC.encode('k'))
    await copy(accessor, spec('/src'), spec('/dst'))
    const children = [...fake.items.values()].filter((i) => i.parents.includes(dst))
    expect(new Set(children.map((i) => i.name))).toEqual(new Set(['keep.txt', 'f.txt']))
  })

  it('dir onto file raises ENOTDIR', async () => {
    fake.folder('src')
    fake.add('f.txt', 'root', undefined, ENC.encode('x'))
    await expect(copy(accessor, spec('/src'), spec('/f.txt'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('missing src raises ENOENT', async () => {
    await expect(copy(accessor, spec('/missing.txt'), spec('/dst.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it.each<[string, boolean, 'file' | 'folder' | null, boolean, string | null, string[][]]>([
    [
      'file-ok',
      false,
      null,
      false,
      null,
      [
        ['copyFile', 'dst.txt'],
        ['write', '/dst.txt'],
      ],
    ],
    [
      'file-fails',
      false,
      'file',
      true,
      'copy failed',
      [['deleteFile'], ['copyFile', 'dst.txt'], ['write', '/dst.txt']],
    ],
    [
      'folder-ok',
      true,
      null,
      false,
      null,
      [
        ['copyFile', 'f.txt'],
        ['subtree', '/dst'],
      ],
    ],
    [
      'folder-fails',
      true,
      'folder',
      true,
      'copy failed',
      [
        ['copyFile', 'f.txt'],
        ['subtree', '/dst'],
      ],
    ],
    ['refused', true, 'file', false, 'ENOTDIR', [['subtree', '/dst']]],
  ])('a copy evicts after it ends: %s', async (_row, folder, dstKind, fails, raised, expected) => {
    let srcPath = '/src.txt'
    let dstPath = '/dst.txt'
    if (folder) {
      const src = fake.folder('src')
      fake.add('f.txt', src, undefined, ENC.encode('new'))
      srcPath = '/src'
      dstPath = '/dst'
    } else {
      fake.add('src.txt', 'root', undefined, ENC.encode('new'))
    }
    const dstName = dstPath.slice(1)
    if (dstKind === 'file') fake.add(dstName, 'root', undefined, ENC.encode('old'))
    else if (dstKind === 'folder') fake.folder(dstName)
    const events: string[][] = []
    const copyFile = fake.copyFile.bind(fake)
    vi.spyOn(fake, 'copyFile').mockImplementation((tm, fileId, name, parentId) => {
      events.push(['copyFile', name])
      if (fails) return Promise.reject(new Error('copy failed'))
      return copyFile(tm, fileId, name, parentId)
    })
    const deleteFile = fake.deleteFile.bind(fake)
    vi.spyOn(fake, 'deleteFile').mockImplementation((tm, fileId) => {
      events.push(['deleteFile'])
      return deleteFile(tm, fileId)
    })
    vi.mocked(invalidateAfterWrite).mockImplementation((path) => {
      events.push(['write', typeof path === 'string' ? path : path.virtual])
      return Promise.resolve()
    })
    vi.mocked(invalidateSubtree).mockImplementation((path) => {
      events.push(['subtree', typeof path === 'string' ? path : path.virtual])
      return Promise.resolve()
    })
    try {
      const copied = copy(accessor, spec(srcPath), spec(dstPath))
      if (raised === 'copy failed') await expect(copied).rejects.toThrow(raised)
      else if (raised !== null) await expect(copied).rejects.toMatchObject({ code: raised })
      else await copied
      expect(events).toEqual(expected)
    } finally {
      vi.mocked(invalidateAfterWrite).mockImplementation(() => Promise.resolve())
      vi.mocked(invalidateSubtree).mockImplementation(() => Promise.resolve())
    }
  })
})
