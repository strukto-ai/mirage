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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import {
  makeAccessor,
  serve,
  spec,
  type FakeDrive9,
} from '../../../tests/core/tidb_filesystem/drive9.ts'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { rename } from './rename.ts'
import { rmRecursive } from './rm.ts'
import { rmdir } from './rmdir.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

let drive9: FakeDrive9
let accessor: TiDBFilesystemAccessor

beforeEach(async () => {
  drive9 = await serve()
  accessor = makeAccessor(drive9)
})

afterEach(async () => {
  await drive9.close()
})

const ENC = new TextEncoder()

async function* stream(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const part of parts) yield part
}

describe('write', () => {
  it('spools a stream and sends it in parts', async () => {
    drive9.partSize = 20_000
    const part = new Uint8Array(10_000).fill(122)
    await write(accessor, spec('/fs/big.bin'), stream(...Array.from({ length: 6 }, () => part)))
    expect(drive9.files.get('/root/big.bin')).toEqual(new Uint8Array(60_000).fill(122))
    expect(drive9.count('PUT', '/s3/upload')).toBe(3)
  })

  it('is one check and one PUT', async () => {
    await write(accessor, spec('/fs/a.txt'), ENC.encode('hello'))
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.requests).toEqual([
      ['POST', '/v1/fs:batch-stat'],
      ['PUT', '/root/a.txt?'],
    ])
  })

  it('refuses a missing folder, a file above and a directory target', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('x'))
    drive9.dirs.add('/root/d')
    await expect(write(accessor, spec('/fs/nope/a'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(write(accessor, spec('/fs/a.txt/b'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    await expect(write(accessor, spec('/fs/d'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    expect(drive9.count('PUT')).toBe(0)
    expect(drive9.dirs.has('/root/nope')).toBe(false)
  })

  it('creates an empty file', async () => {
    await create(accessor, spec('/fs/empty'))
    expect(drive9.files.get('/root/empty')).toEqual(new Uint8Array())
  })
})

describe('mkdir', () => {
  it('makes one directory and refuses a missing parent or a file', async () => {
    drive9.files.set('/root/f', ENC.encode('x'))
    await mkdir(accessor, spec('/fs/d'))
    expect(drive9.dirs.has('/root/d')).toBe(true)
    await expect(mkdir(accessor, spec('/fs/a/b'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(mkdir(accessor, spec('/fs/f'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(drive9.dirs.has('/root/a')).toBe(false)
  })

  it('makes a chain with -p, and stops at a file it crosses', async () => {
    drive9.files.set('/root/f', ENC.encode('x'))
    await mkdir(accessor, spec('/fs/a/b/c'), true)
    expect(drive9.dirs.has('/root/a/b/c')).toBe(true)
    await mkdir(accessor, spec('/fs/a'), true)
    expect(drive9.count('POST', '/root/a?')).toBe(0)
    await expect(mkdir(accessor, spec('/fs/f/sub'), true)).rejects.toMatchObject({
      code: 'ENOTDIR',
      virtualPath: '/fs/f',
    })
  })
})

describe('remove', () => {
  it('unlinks a file in one DELETE and refuses a directory', async () => {
    drive9.files.set('/root/f', ENC.encode('x'))
    drive9.dirs.add('/root/d')
    await unlink(accessor, spec('/fs/f'))
    expect(drive9.requests).toEqual([['DELETE', '/root/f?kind']])
    await expect(unlink(accessor, spec('/fs/d'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(unlink(accessor, spec('/fs/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses rmdir of a full directory and of a file', async () => {
    drive9.dirs.add('/root/d')
    drive9.files.set('/root/d/f', ENC.encode('x')).set('/root/g', ENC.encode('y'))
    await expect(rmdir(accessor, spec('/fs/d'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await expect(rmdir(accessor, spec('/fs/g'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(drive9.files.has('/root/g')).toBe(true)
  })

  it('removes a tree in one DELETE', async () => {
    drive9.dirs.add('/root/d').add('/root/d/e')
    drive9.files.set('/root/d/e/f', ENC.encode('x'))
    await rmRecursive(accessor, spec('/fs/d'))
    expect([...drive9.dirs]).toEqual(['/root'])
    expect(drive9.requests).toEqual([['DELETE', '/root/d?recursive']])
    await expect(rmRecursive(accessor, spec('/fs/nope'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('rename', () => {
  it('moves a file over another after one check', async () => {
    drive9.files.set('/root/a', ENC.encode('a')).set('/root/b', ENC.encode('b'))
    await rename(accessor, spec('/fs/a'), spec('/fs/b'))
    expect([...drive9.files]).toEqual([['/root/b', ENC.encode('a')]])
    expect(drive9.count('POST', '/v1/fs:batch-stat')).toBe(1)
  })

  it('moves a directory with its tree', async () => {
    drive9.dirs.add('/root/d').add('/root/d/e').add('/root/x')
    drive9.files.set('/root/d/e/f', ENC.encode('x'))
    await rename(accessor, spec('/fs/d'), spec('/fs/x/d2'))
    expect([...drive9.files.keys()]).toEqual(['/root/x/d2/e/f'])
    expect(drive9.dirs.has('/root/d')).toBe(false)
  })

  it('refuses a missing folder and a full directory, and skips itself', async () => {
    drive9.files.set('/root/a', ENC.encode('a')).set('/root/full/x', ENC.encode('x'))
    drive9.dirs.add('/root/d').add('/root/full')
    await expect(rename(accessor, spec('/fs/a'), spec('/fs/nope/a'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(rename(accessor, spec('/fs/d'), spec('/fs/full'))).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
    await rename(accessor, spec('/fs/a'), spec('/fs/a'))
    expect(drive9.count('POST', '/root/a?')).toBe(0)
  })
})
