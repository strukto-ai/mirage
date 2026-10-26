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
import { makeAccessor, serve, type FakeDrive9 } from '../../../tests/core/tidb_filesystem/drive9.ts'
import { ByteSpool } from '../../io/spool.ts'
import { appendTo, download, move, removeTree, statEntries, upload } from './client.ts'
import { MAX_UPLOAD_WORKERS } from './constants.ts'

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

describe('upload', () => {
  it('sends a small file in one PUT', async () => {
    await upload(accessor, '/root/a.txt', ENC.encode('hello'))
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.requests).toEqual([['PUT', '/root/a.txt?']])
  })

  it('sends a large file in parts, presigned in batches, without the token', async () => {
    drive9.partSize = 1_000
    const data = new Uint8Array(50_500).map((_, i) => i % 251)
    await upload(accessor, '/root/big.bin', data)
    expect(drive9.files.get('/root/big.bin')).toEqual(data)
    expect(drive9.count('PUT', '/s3/upload')).toBe(51)
    expect(drive9.count('POST', '/v2/uploads/presign-batch')).toBe(4)
    expect(drive9.leaked).toEqual([])
    expect(drive9.uploads.size).toBe(0)
  })

  it('aborts the upload when a part fails', async () => {
    drive9.partSize = 20_000
    drive9.failParts = true
    await expect(upload(accessor, '/root/big.bin', new Uint8Array(60_000))).rejects.toThrow()
    expect(drive9.count('POST', '/v2/uploads/abort')).toBe(1)
    expect(drive9.files.has('/root/big.bin')).toBe(false)
  })

  it('sends a few parts at a time', async () => {
    drive9.partSize = 10_000
    drive9.partDelay = 20
    const data = new Uint8Array(102_400).map((_, i) => i % 256)
    await upload(accessor, '/root/big.bin', data)
    expect(drive9.peak).toBe(MAX_UPLOAD_WORKERS)
    expect(drive9.files.get('/root/big.bin')).toEqual(data)
  })

  it('sends a spooled body from its spool', async () => {
    drive9.partSize = 20_000
    const data = new Uint8Array(76_800).map((_, i) => i % 256)
    const spool = new ByteSpool(1_000)
    try {
      await spool.append(data)
      await upload(accessor, '/root/big.bin', spool)
    } finally {
      await spool.close()
    }
    expect(drive9.files.get('/root/big.bin')).toEqual(data)
  })
})

describe('appendTo', () => {
  it('sends only the last part and the new bytes', async () => {
    drive9.partSize = 25_000
    const head = new Uint8Array(60_160).map((_, i) => i % 256)
    drive9.files.set('/root/big.bin', head)
    const tail = ENC.encode('tail'.repeat(7_500))
    expect(await appendTo(accessor, '/root/big.bin', tail)).toBe(true)
    const want = new Uint8Array(head.byteLength + tail.byteLength)
    want.set(head)
    want.set(tail, head.byteLength)
    expect(drive9.files.get('/root/big.bin')).toEqual(want)
    expect(drive9.count('GET', '/s3/objects')).toBe(1)
    expect(drive9.count('PUT', '/s3/upload')).toBe(2)
    expect(drive9.count('PUT', '/root')).toBe(0)
    expect(drive9.leaked).toEqual([])
    expect(drive9.uploads.size).toBe(0)
  })

  it('sends nothing for an inline or a missing file', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    expect(await appendTo(accessor, '/root/a.txt', ENC.encode('!'))).toBe(false)
    expect(await appendTo(accessor, '/root/nope', ENC.encode('!'))).toBe(false)
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.files.has('/root/nope')).toBe(false)
    expect(drive9.uploads.size).toBe(0)
  })

  it('aborts the upload when a part fails', async () => {
    drive9.partSize = 25_000
    drive9.files.set('/root/big.bin', new Uint8Array(60_000))
    drive9.failParts = true
    await expect(appendTo(accessor, '/root/big.bin', new Uint8Array(100))).rejects.toThrow()
    expect(drive9.count('DELETE', '/v1/uploads/')).toBe(1)
    expect(drive9.files.get('/root/big.bin')).toEqual(new Uint8Array(60_000))
    expect(drive9.uploads.size).toBe(0)
  })

  it('refuses a plan without the old bytes', async () => {
    drive9.partSize = 25_000
    drive9.files.set('/root/big.bin', new Uint8Array(60_000))
    drive9.dropReadUrls = true
    await expect(appendTo(accessor, '/root/big.bin', new Uint8Array(100))).rejects.toThrow(
      'does not match',
    )
    expect(drive9.count('PUT', '/s3/upload')).toBe(0)
    expect(drive9.uploads.size).toBe(0)
  })
})

describe('download', () => {
  it('follows a large read to its object without the token', async () => {
    const data = new Uint8Array(102_400).map((_, i) => i % 256)
    drive9.files.set('/root/big.bin', data)
    expect(await download(accessor, '/root/big.bin')).toEqual(data)
    expect(await download(accessor, '/root/big.bin', { offset: 100, size: 50 })).toEqual(
      data.subarray(100, 150),
    )
    expect(drive9.leaked).toEqual([])
  })

  it('trims an inline read to the window', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('0123456789'))
    expect(await download(accessor, '/root/a.txt', { offset: 2, size: 3 })).toEqual(
      ENC.encode('234'),
    )
  })
})

describe('statEntries', () => {
  it('answers each path and splits at the batch limit', async () => {
    drive9.files.set('/root/a', ENC.encode('abc'))
    drive9.dirs.add('/root/d')
    const missing = Array.from({ length: 300 }, (_, i) => `/root/m${String(i)}`)
    const found = await statEntries(accessor, ['/root/a', '/root/d', ...missing])
    expect(found.slice(0, 3)).toEqual([
      { name: 'a', isDir: false, size: 3, mtime: 1792965402 },
      { name: 'd', isDir: true, size: 0, mtime: 1792965402 },
      null,
    ])
    expect(drive9.count('POST', '/v1/fs:batch-stat')).toBe(2)
  })
})

describe('removeTree', () => {
  it('resends after the server answers busy', async () => {
    drive9.dirs.add('/root/d').add('/root/d/e')
    drive9.files.set('/root/d/e/f', ENC.encode('x'))
    drive9.busyDeletes = 2
    await removeTree(accessor, '/root/d')
    expect(drive9.count('DELETE')).toBe(3)
    expect([...drive9.dirs]).toEqual(['/root'])
  })
})

describe('move', () => {
  it('carries a non-Latin source', async () => {
    drive9.files.set('/root/你好 x.txt', ENC.encode('hi'))
    await move(accessor, '/root/你好 x.txt', '/root/moved.txt')
    expect([...drive9.files.keys()]).toEqual(['/root/moved.txt'])
  })
})
