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
import { readStream } from './stream.ts'
import { mkdir } from './mkdir.ts'
import { write } from './write.ts'

describe('opfs/stream', () => {
  it('yields all bytes', async () => {
    const accessor = makeMockAccessor()
    await write(accessor, spec('/x'), new TextEncoder().encode('hello stream'))
    const chunks: Uint8Array[] = []
    for await (const c of readStream(accessor, spec('/x'))) chunks.push(c)
    const decoded = chunks.map((c) => new TextDecoder().decode(c)).join('')
    expect(decoded).toBe('hello stream')
  })
  it('throws "file not found" on missing', async () => {
    const accessor = makeMockAccessor()
    const it = readStream(accessor, spec('/missing'))
    await expect(it[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// OPFS raises one TypeMismatchError for a plain file in the chain and for a
// directory at the leaf, where open(2) answers ENOTDIR and EISDIR.
describe('opfs/stream tells a file in the chain from a directory leaf', () => {
  it('is ENOTDIR under a plain file and EISDIR for a directory', async () => {
    const accessor = makeMockAccessor()
    await write(accessor, spec('/plain'), new TextEncoder().encode('p'))
    await mkdir(accessor, spec('/d'))
    const codeOf = async (p: string): Promise<unknown> =>
      (async () => {
        for await (const chunk of readStream(accessor, spec(p))) void chunk
      })().then(
        () => null,
        (e: unknown) => (e as { code?: string }).code,
      )
    expect(await codeOf('/plain/x')).toBe('ENOTDIR')
    expect(await codeOf('/plain/x/y')).toBe('ENOTDIR')
    expect(await codeOf('/d')).toBe('EISDIR')
    expect(await codeOf('/nope/x')).toBe('ENOENT')
  })
})
