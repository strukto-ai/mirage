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

import { describe, expect, it } from 'vitest'
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { mkdir } from './mkdir.ts'
import { rmdir } from './rmdir.ts'
import { writeBytes } from './write.ts'

const ENC = new TextEncoder()

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function accessor(): RAMAccessor {
  return new RAMAccessor(new RAMStore())
}

describe('ram rmdir', () => {
  it('removes an empty directory', async () => {
    const acc = accessor()
    await mkdir(acc, spec('/dir'))
    await rmdir(acc, spec('/dir'))
    expect(acc.store.dirs.has('/dir')).toBe(false)
  })

  it('refuses a directory holding a file, leaving the file reachable', async () => {
    const acc = accessor()
    await mkdir(acc, spec('/dir'))
    await writeBytes(acc, spec('/dir/f.txt'), ENC.encode('keep'))
    await expect(rmdir(acc, spec('/dir'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    // The directory has to survive too: dropping it while its children
    // stay keyed is what left them addressable but unreachable.
    expect(acc.store.dirs.has('/dir')).toBe(true)
    expect(acc.store.files.has('/dir/f.txt')).toBe(true)
  })

  it('refuses a directory holding only a subdirectory', async () => {
    const acc = accessor()
    await mkdir(acc, spec('/dir'))
    await mkdir(acc, spec('/dir/sub'))
    await expect(rmdir(acc, spec('/dir'))).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(acc.store.dirs.has('/dir/sub')).toBe(true)
  })

  it('reports ENOENT for a directory the store does not have', async () => {
    await expect(rmdir(accessor(), spec('/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
