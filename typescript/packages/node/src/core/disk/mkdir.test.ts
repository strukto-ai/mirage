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

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { mkdir } from './mkdir.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(() => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-mkdir-'))
})
afterEach(() => {
  cleanup()
})

describe('core/disk/mkdir', () => {
  it('creates a single-level directory', async () => {
    await mkdir(accessor, spec('/d'))
    expect((await stat(join(root, 'd'))).isDirectory()).toBe(true)
  })

  it('is ENOENT when the parent is missing and parents=false', async () => {
    // The kernel's errno is kept and restamped against the mount, so the
    // command layer can render the GNU strerror and no host path leaks.
    await expect(mkdir(accessor, spec('/a/b'))).rejects.toMatchObject({
      code: 'ENOENT',
      virtualPath: '/a/b',
    })
  })

  it('creates nested directories with parents=true', async () => {
    await mkdir(accessor, spec('/a/b/c'), true)
    expect((await stat(join(root, 'a/b/c'))).isDirectory()).toBe(true)
  })

  it('is a no-op when directory already exists', async () => {
    await mkdir(accessor, spec('/d'))
    await expect(mkdir(accessor, spec('/d'))).resolves.toBeUndefined()
  })
})
