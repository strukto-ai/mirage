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

const renameOp = opOf(DISK_OPS, 'rename')

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-rename-op-'))
  res = new DiskResource({ root })
  await res.open()
})
afterEach(() => {
  cleanup()
})

describe('renameOp', () => {
  it('moves a file from src to dst', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('hi'))
    await renameOp.fn(res.accessor, spec('/a'), [spec('/b')], {})
    expect(await res.exists(spec('/a'))).toBe(false)
    expect(new TextDecoder().decode(await res.readFile(spec('/b')))).toBe('hi')
  })

  it('throws when destination is not a PathSpec', () => {
    expect(() => renameOp.fn(res.accessor, spec('/a'), ['plain string'], {})).toThrow(
      /dst PathSpec/,
    )
  })
})
