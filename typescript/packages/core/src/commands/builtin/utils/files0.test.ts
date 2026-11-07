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
import { enoent } from '../../../errors/fs.ts'
import { asyncChain } from '../../../io/stream.ts'
import { PathSpec } from '../../../types.ts'
import { listedNames } from './files0.ts'

const ENC = new TextEncoder()
const LIST = PathSpec.fromStrPath('/l')

function reader(data: string, size = 3): (p: PathSpec) => AsyncIterable<Uint8Array> {
  const bytes = ENC.encode(data)
  const pieces: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size))
  return () => asyncChain(pieces)
}

describe('listedNames', () => {
  it.each([
    ['a\0bc\0', ['a', 'bc']],
    ['a\0bc', ['a', 'bc']],
    ['a\0\0b\0', ['a', '', 'b']],
    ['', []],
  ])('%j ends each name at a NUL, the last one optional', async (data, names) => {
    expect(await listedNames(LIST, reader(data))).toEqual(names)
  })

  it('lets a failed read propagate', async () => {
    const failing = (): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(enoent(LIST)) }),
    })
    await expect(listedNames(LIST, failing)).rejects.toThrow()
  })
})
