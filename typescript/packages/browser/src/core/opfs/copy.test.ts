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
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { copy } from './copy.ts'
import { read } from './read.ts'
import { writeBytes } from './write.ts'

describe('opfs/copy', () => {
  it('duplicates a file', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/src'), new TextEncoder().encode('CP'))
    await copy(accessor, spec('/src'), spec('/dst'))
    expect(new TextDecoder().decode(await read(accessor, spec('/dst')))).toBe('CP')
  })
  it('does not create parent directories for the destination', async () => {
    // cp is not `mkdir -p`: GNU reports ENOENT on the destination rather
    // than building the chain, and leaves nothing behind.
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/src'), new TextEncoder().encode('X'))
    await expect(copy(accessor, spec('/src'), spec('/a/b/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('a destination parent that is a plain file is ENOTDIR', async () => {
    const accessor = makeMockAccessor()
    await writeBytes(accessor, spec('/src'), new TextEncoder().encode('X'))
    await writeBytes(accessor, spec('/plain'), new TextEncoder().encode('y'))
    await expect(copy(accessor, spec('/src'), spec('/plain/dst'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('a missing source is ENOENT', async () => {
    const accessor = makeMockAccessor()
    await expect(copy(accessor, spec('/nope'), spec('/dst'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
