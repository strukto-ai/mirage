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
import { FileStat, FileType } from '@struktoai/mirage-core'
import { DiskResource } from '../../resource/disk/disk.ts'
import { opOf, spec, tmpRoot } from '../../test-utils.ts'
import { DISK_OPS } from './index.ts'

const statOp = opOf(DISK_OPS, 'stat')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-stat-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('statOp', () => {
  it('returns FileStat for a file', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('abc'))
    const s = (await statOp.fn(res.accessor, spec('/x'), [], {})) as FileStat
    expect(s).toBeInstanceOf(FileStat)
    expect(s.size).toBe(3)
    expect(s.type).not.toBe(FileType.DIRECTORY)
  })

  it('returns DIRECTORY type for a directory', async () => {
    await res.mkdir(spec('/d'))
    const s = (await statOp.fn(res.accessor, spec('/d'), [], {})) as FileStat
    expect(s.type).toBe(FileType.DIRECTORY)
  })

  it('throws on missing path', async () => {
    await expect(statOp.fn(res.accessor, spec('/nope'), [], {})).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
