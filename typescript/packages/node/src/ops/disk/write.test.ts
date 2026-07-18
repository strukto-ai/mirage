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

const writeOp = opOf(DISK_OPS, 'write')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-write-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('writeOp', () => {
  it('writes bytes to disk', async () => {
    await writeOp.fn(res.accessor, spec('/x.txt'), [new TextEncoder().encode('hello')], {})
    expect(new TextDecoder().decode(await res.readFile(spec('/x.txt')))).toBe('hello')
  })

  it('throws when first arg is not a Uint8Array', () => {
    expect(() => writeOp.fn(res.accessor, spec('/x'), ['not bytes'], {})).toThrow(/Uint8Array/)
  })
})
