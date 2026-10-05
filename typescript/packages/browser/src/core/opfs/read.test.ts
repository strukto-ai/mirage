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
import { makeMockAccessor, spec } from '../../test-utils.ts'
import { read } from './read.ts'
import { mkdir } from './mkdir.ts'
import { write } from './write.ts'

let accessor: ReturnType<typeof makeMockAccessor>
beforeEach(() => {
  accessor = makeMockAccessor()
})
afterEach(() => undefined)

describe('opfs/read', () => {
  it('returns file bytes', async () => {
    await write(accessor, spec('/x'), new TextEncoder().encode('hello'))
    expect(new TextDecoder().decode(await read(accessor, spec('/x')))).toBe('hello')
  })
  it('throws "file not found" on missing', async () => {
    await expect(read(accessor, spec('/nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('slices the window off the File rather than reading the whole thing', async () => {
    await write(accessor, spec('/w'), new TextEncoder().encode('0123456789'))
    const dec = new TextDecoder()
    expect(dec.decode(await read(accessor, spec('/w'), undefined, { offset: 2, size: 3 }))).toBe(
      '234',
    )
    expect(dec.decode(await read(accessor, spec('/w'), undefined, { offset: 7 }))).toBe('789')
    expect(dec.decode(await read(accessor, spec('/w'), undefined, { size: 4 }))).toBe('0123')
  })
  it('clamps a window past EOF instead of throwing', async () => {
    await write(accessor, spec('/s'), new TextEncoder().encode('abc'))
    const dec = new TextDecoder()
    expect(dec.decode(await read(accessor, spec('/s'), undefined, { size: 100 }))).toBe('abc')
    expect((await read(accessor, spec('/s'), undefined, { offset: 99, size: 5 })).byteLength).toBe(
      0,
    )
  })
})

// OPFS raises one TypeMismatchError for a plain file in the chain and for a
// directory at the leaf, where open(2) answers ENOTDIR and EISDIR.
describe('opfs/read tells a file in the chain from a directory leaf', () => {
  it('is ENOTDIR under a plain file and EISDIR for a directory', async () => {
    const accessor = makeMockAccessor()
    await write(accessor, spec('/plain'), new TextEncoder().encode('p'))
    await mkdir(accessor, spec('/d'))
    const codeOf = async (p: string): Promise<unknown> =>
      read(accessor, spec(p)).then(
        () => null,
        (e: unknown) => (e as { code?: string }).code,
      )
    expect(await codeOf('/plain/x')).toBe('ENOTDIR')
    expect(await codeOf('/plain/x/y')).toBe('ENOTDIR')
    expect(await codeOf('/d')).toBe('EISDIR')
    expect(await codeOf('/nope/x')).toBe('ENOENT')
  })
})
