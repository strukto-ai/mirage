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
import { append } from './append.ts'

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

describe('append', () => {
  it('hands a large file the bytes natively', async () => {
    drive9.partSize = 25_000
    drive9.files.set('/root/big.bin', new Uint8Array(60_000).fill(120))
    const [, records] = await runWithRecording(() =>
      append(accessor, spec('/fs/big.bin'), stream(ENC.encode('ab'), ENC.encode('cd'))),
    )
    const want = new Uint8Array(60_004).fill(120)
    want.set(ENC.encode('abcd'), 60_000)
    expect(drive9.files.get('/root/big.bin')).toEqual(want)
    expect(drive9.count('GET', '/root')).toBe(0)
    expect(records.map((r) => [r.op, r.path, r.bytes])).toEqual([['append', '/fs/big.bin', 4]])
  })

  it('reads an inline file and writes it back', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await append(accessor, spec('/fs/a.txt'), ENC.encode(' world'))
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello world'))
  })

  it('makes a missing file', async () => {
    await append(accessor, spec('/fs/new.txt'), ENC.encode('first'))
    expect(drive9.files.get('/root/new.txt')).toEqual(ENC.encode('first'))
  })

  it('makes a missing file and leaves an existing one alone when nothing is added', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('hello'))
    await append(accessor, spec('/fs/new.txt'), new Uint8Array())
    await append(accessor, spec('/fs/a.txt'), new Uint8Array())
    expect(drive9.files.get('/root/new.txt')).toEqual(new Uint8Array())
    expect(drive9.files.get('/root/a.txt')).toEqual(ENC.encode('hello'))
    expect(drive9.count('POST', '/root')).toBe(0)
  })

  it('refuses a directory and a missing folder', async () => {
    drive9.dirs.add('/root/d')
    await expect(append(accessor, spec('/fs/d'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(append(accessor, spec('/fs/nope/a.txt'), ENC.encode('x'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(drive9.files.has('/root/d')).toBe(false)
    expect(drive9.dirs.has('/root/nope')).toBe(false)
  })
})
