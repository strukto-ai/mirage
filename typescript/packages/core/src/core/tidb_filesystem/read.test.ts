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
import { read } from './read.ts'
import { readStream } from './stream.ts'

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

async function drain(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of source) parts.push(part)
  return new Uint8Array(parts.flatMap((p) => [...p]))
}

describe('read', () => {
  it('reads a window', async () => {
    drive9.files.set('/root/a.txt', ENC.encode('0123456789'))
    expect(await read(accessor, spec('/fs/a.txt'), 3, 4)).toEqual(ENC.encode('3456'))
  })

  it('streams a large file', async () => {
    const data = new Uint8Array(70_000).fill(122)
    drive9.files.set('/root/big', data)
    expect(await drain(readStream(accessor, spec('/fs/big')))).toEqual(data)
    expect(drive9.leaked).toEqual([])
  })

  it('answers EISDIR, ENOENT and ENOTSUP', async () => {
    drive9.dirs.add('/root/d')
    drive9.files.set('/root/db.sqlite', new Uint8Array())
    drive9.extent.add('/root/db.sqlite')
    await expect(read(accessor, spec('/fs/d'), 0, 10)).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(drain(readStream(accessor, spec('/fs/nope')))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(read(accessor, spec('/fs/db.sqlite'), 0, 10)).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
  })
})
