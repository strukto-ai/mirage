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

const appendOp = opOf(DISK_OPS, 'append')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-append-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('appendOp', () => {
  it('appends to an existing file', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('A'))
    await appendOp.fn(res.accessor, spec('/x'), [new TextEncoder().encode('B')], {})
    expect(new TextDecoder().decode(await res.readFile(spec('/x')))).toBe('AB')
  })

  it('creates the file when it does not exist yet', async () => {
    await appendOp.fn(res.accessor, spec('/new'), [new TextEncoder().encode('hi')], {})
    expect(new TextDecoder().decode(await res.readFile(spec('/new')))).toBe('hi')
  })

  it('throws on non-Uint8Array first arg', () => {
    expect(() => appendOp.fn(res.accessor, spec('/x'), ['nope'], {})).toThrow(/Uint8Array/)
  })
})
