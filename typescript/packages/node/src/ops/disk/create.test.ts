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
import { DiskResource } from '../../resource/disk/disk.ts'
import { opOf, spec, tmpRoot } from '../../test-utils.ts'
import { DISK_OPS } from './index.ts'

const createOp = opOf(DISK_OPS, 'create')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-create-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('createOp', () => {
  it('creates an empty file', async () => {
    await createOp.fn(res.accessor, spec('/empty'), [], {})
    expect((await res.readFile(spec('/empty'))).byteLength).toBe(0)
    expect(await res.exists(spec('/empty'))).toBe(true)
  })

  it('overwrites an existing file with empty contents', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('full'))
    await createOp.fn(res.accessor, spec('/x'), [], {})
    expect((await res.readFile(spec('/x'))).byteLength).toBe(0)
  })
})
