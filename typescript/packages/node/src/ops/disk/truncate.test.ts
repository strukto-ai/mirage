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

const truncateOp = opOf(DISK_OPS, 'truncate')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-truncate-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('truncateOp', () => {
  it('truncates a file to the given length', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('hello world'))
    await truncateOp.fn(res.accessor, spec('/x'), [5], {})
    expect(new TextDecoder().decode(await res.readFile(spec('/x')))).toBe('hello')
  })

  it('zero-fills when growing past existing size', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('ab'))
    await truncateOp.fn(res.accessor, spec('/x'), [5], {})
    const out = await res.readFile(spec('/x'))
    expect(out.byteLength).toBe(5)
    expect(out[0]).toBe(0x61) // 'a'
    expect(out[1]).toBe(0x62) // 'b'
    expect(out[2]).toBe(0)
  })

  it('throws on non-numeric length', () => {
    expect(() => truncateOp.fn(res.accessor, spec('/x'), ['long'], {})).toThrow(/number length/)
  })
})
