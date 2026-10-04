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

import { access, mkdir as mkdirFs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { rmdir } from './rmdir.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-rmdir-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/rmdir', () => {
  it('removes an empty directory', async () => {
    await mkdirFs(join(root, 'd'))
    await rmdir(accessor, spec('/d'))
    await expect(access(join(root, 'd'))).rejects.toThrow()
  })
  it('is ENOENT on a missing dir', async () => {
    await expect(rmdir(accessor, spec('/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// A path under a plain file is ENOTDIR on the real filesystem, stamped with
// the virtual path: Node's own message names the host path, which must never
// reach a diagnostic. Mirrors the disk tests in python/tests/core/disk.
describe('core/disk/rmdir under a plain file', () => {
  it('is ENOTDIR against the virtual path', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    const err: unknown = await rmdir(accessor, spec('/a.txt/x')).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'ENOTDIR', virtualPath: '/a.txt/x' })
    expect((err as Error).message).not.toContain(root)
  })
})
