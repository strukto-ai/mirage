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

import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { type DirListing, PathSpec } from '@struktoai/mirage-core/types'
import { mountKey } from '@struktoai/mirage-core/utils/key_prefix'
import { spec, tmpRoot } from '../../test-utils.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-readdir-'))
})
afterEach(() => {
  cleanup()
})

function paths(listing: DirListing, virtual: string): string[] {
  const base = virtual.replace(/\/+$/, '')
  return listing.entries.map((row) => `${base}/${row.name}`)
}

describe('core/disk/readdir', () => {
  it('lists the children sorted', async () => {
    await writeFile(join(root, 'b'), '')
    await writeFile(join(root, 'a'), '')
    expect(paths(await readdir(accessor, spec('/')), '/')).toEqual(['/a', '/b'])
  })

  it('answers each row as stat does', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'file.txt'), 'data')
    const listing = await readdir(accessor, spec('/'))
    for (const row of listing.entries) {
      expect(row).toEqual(await stat(accessor, spec(`/${row.name}`)))
    }
  })

  it('leaves a host symlink out', async () => {
    await mkdir(join(root, 'lib'))
    await symlink('lib', join(root, 'lib64'))
    await symlink('/nowhere/python3', join(root, 'python'))
    expect(paths(await readdir(accessor, spec('/')), '/')).toEqual(['/lib'])
  })

  it('refuses a directory reached through a host symlink', async () => {
    await mkdir(join(root, 'lib'))
    await symlink('lib', join(root, 'lib64'))
    await expect(readdir(accessor, spec('/lib64'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists nested directory', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'x'), '')
    expect(paths(await readdir(accessor, spec('/sub')), '/sub')).toEqual(['/sub/x'])
  })

  it('throws ENOENT on a missing path', async () => {
    await expect(readdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT however deep the missing component is', async () => {
    await mkdir(join(root, 'sub'))
    await expect(readdir(accessor, spec('/sub/gone/deeper'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('throws ENOTDIR when a path component is a file', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await expect(readdir(accessor, spec('/a.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(readdir(accessor, spec('/a.txt/x'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('lists a prefixed mount the same with or without a trailing slash', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const slashed = new PathSpec({
      virtual: '/data/',
      directory: '/data/',
      vfsPath: mountKey('/data/', '/data'),
    })
    const bare = new PathSpec({
      virtual: '/data',
      directory: '/data',
      vfsPath: mountKey('/data', '/data'),
    })
    const first = paths(await readdir(accessor, slashed), '/data')
    expect(first).toEqual(['/data/a.txt'])
    expect(paths(await readdir(accessor, bare), '/data')).toEqual(first)
  })
})
