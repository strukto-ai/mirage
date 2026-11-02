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
import { runWithRecording } from '../../observe/context.ts'
import {
  makeAccessor,
  serve,
  spec,
  type FakeDrive9,
} from '../../../tests/core/tidb_filesystem/drive9.ts'
import { TiDBFilesystemApiError } from './errors.ts'
import { truncate } from './truncate.ts'

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
const MIB = 1024 * 1024

function big(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = i % 256
  return out
}

describe('truncate', () => {
  it('cuts a large file moving only the last part', async () => {
    const data = big(9 * MIB)
    drive9.files.set('/root/big.bin', data)
    const [, records] = await runWithRecording(() =>
      truncate(accessor, spec('/fs/big.bin'), 8 * MIB + 5),
    )
    const got = Buffer.from(drive9.files.get('/root/big.bin') ?? [])
    expect(got.equals(data.subarray(0, 8 * MIB + 5))).toBe(true)
    expect(drive9.count('PUT', '/s3/upload')).toBe(1)
    expect(drive9.count('GET', '/s3/objects')).toBe(1)
    expect(drive9.count('GET', '/root')).toBe(0)
    expect(drive9.count('PUT', '/root')).toBe(0)
    expect(records.map((r) => [r.op, r.path])).toEqual([['truncate', '/fs/big.bin']])
  })

  it('keeps the head of a large file cut below the inline size', async () => {
    const data = big(60_000)
    drive9.files.set('/root/big.bin', data)
    await truncate(accessor, spec('/fs/big.bin'), 10)
    expect(drive9.files.get('/root/big.bin')).toEqual(data.slice(0, 10))
    expect(drive9.count('PATCH', '/root')).toBe(1)
  })

  it('grows a large file by a native append of zeros', async () => {
    drive9.partSize = 25_000
    drive9.files.set('/root/big.bin', new Uint8Array(60_000).fill(120))
    await truncate(accessor, spec('/fs/big.bin'), 70_000)
    const want = new Uint8Array(70_000)
    want.fill(120, 0, 60_000)
    expect(drive9.files.get('/root/big.bin')).toEqual(want)
    expect(drive9.count('GET', '/root')).toBe(0)
    expect(drive9.count('PUT', '/root')).toBe(0)
  })

  it('cuts an inline file by a rewrite', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello world'))
    await truncate(accessor, spec('/fs/a.txt'), 5)
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
  })

  it('grows an inline file by a rewrite', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hi'))
    await truncate(accessor, spec('/fs/a.txt'), 5)
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hi\0\0\0'))
  })

  it('sends an inline file grown past the inline size multipart', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hi'))
    await truncate(accessor, spec('/fs/a.txt'), 60_000)
    const want = new Uint8Array(60_000)
    want.set(ENC.encode('hi'))
    expect(drive9.files.get('/root/a.txt')).toEqual(want)
  })

  it('reads nothing to empty a file', async () => {
    drive9.files.set('/root/big.bin', big(60_000))
    await truncate(accessor, spec('/fs/big.bin'), 0)
    expect(drive9.files.get('/root/big.bin')).toEqual(new Uint8Array())
    expect(drive9.count('GET')).toBe(0)
    expect(drive9.count('PATCH')).toBe(0)
  })

  it('makes a missing file of zeros', async () => {
    await truncate(accessor, spec('/fs/new.bin'), 3)
    expect(drive9.files.get('/root/new.bin')).toEqual(new Uint8Array(3))
  })

  it('sends no write for the same size', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await truncate(accessor, spec('/fs/a.txt'), 5)
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.count('PUT')).toBe(0)
    expect(drive9.count('PATCH')).toBe(0)
  })

  it('refuses a directory', async () => {
    drive9.dirs.add('/root/d')
    await expect(truncate(accessor, spec('/fs/d'), 3)).rejects.toMatchObject({ code: 'EISDIR' })
    expect(drive9.count('PUT')).toBe(0)
  })

  it('refuses noCreate before anything is sent', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await expect(truncate(accessor, spec('/fs/a.txt'), 2, true)).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.requests).toEqual([])
  })

  it('refuses a negative length', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await expect(truncate(accessor, spec('/fs/a.txt'), -1)).rejects.toMatchObject({
      code: 'EINVAL',
    })
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
  })

  it('aborts the patch when a part fails', async () => {
    const data = big(60_000)
    drive9.files.set('/root/big.bin', data)
    drive9.failParts = true
    await expect(truncate(accessor, spec('/fs/big.bin'), 10)).rejects.toBeInstanceOf(
      TiDBFilesystemApiError,
    )
    expect(drive9.files.get('/root/big.bin')).toEqual(data)
    expect(drive9.uploads.size).toBe(0)
  })
})
