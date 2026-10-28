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

import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core/types'
import { tmpRoot } from '../../../tests/test-utils.ts'
import { DiskAccessor } from '../../accessor/disk.ts'
import { count, sizeOf } from './capacity.ts'

describe('disk capacity', () => {
  it('counts a file, a subtree and nothing', async () => {
    const root = tmpRoot().root
    await mkdir(join(root, 'd', 'e'), { recursive: true })
    await writeFile(join(root, 'a'), '123')
    await writeFile(join(root, 'd', 'b'), '4567')
    await writeFile(join(root, 'd', 'e', 'c'), '89')
    await symlink(join(root, 'a'), join(root, 'd', 'link'))
    const accessor = new DiskAccessor(root)
    expect(await sizeOf(accessor, PathSpec.fromStrPath('/a'))).toBe(3)
    expect(await sizeOf(accessor, PathSpec.fromStrPath('/d'))).toBe(6)
    expect(await sizeOf(accessor, PathSpec.fromStrPath('/none'))).toBe(0)
    expect(await count(accessor)).toBe(9)
  })
})
