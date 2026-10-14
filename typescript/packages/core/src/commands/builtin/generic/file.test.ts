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

import { materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { fileGeneric } from './file.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const X = PathSpec.fromStrPath('/x')
const OPTS = { flags: {}, stdin: null } as unknown as CommandOpts
const stat = (): Promise<FileStat> =>
  Promise.resolve(new FileStat({ name: 'x', size: 10 ** 6, type: FileType.FILE }))

describe('file reads only the first bytes', () => {
  // Mirrors python's test_file_reads_only_the_first_bytes.
  it('stops the stream once the header is in', async () => {
    const pulled: number[] = []
    const stream = async function* (): AsyncIterable<Uint8Array> {
      for (let n = 0; n < 1000; n++) {
        await Promise.resolve()
        pulled.push(n)
        yield n === 0 ? ENC.encode('%PDF-1.4\n') : ENC.encode('x'.repeat(1000))
      }
    }
    const [out] = (await fileGeneric([X], OPTS, stat, stream)) ?? [null]
    expect(DEC.decode(await materialize(out))).toBe('/x: application/pdf\n')
    expect(pulled).toHaveLength(2)
  })

  // Mirrors python's test_file_asks_a_ranged_read_for_the_header.
  it('asks a ranged read for the header', async () => {
    const asked: [number, number | null][] = []
    const stream = (): AsyncIterable<Uint8Array> => {
      throw new Error('streamed')
    }
    const readRange = (_p: PathSpec, offset: number, size: number | null): Promise<Uint8Array> => {
      asked.push([offset, size])
      return Promise.resolve(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    }
    const [out] = (await fileGeneric([X], OPTS, stat, stream, readRange)) ?? [null]
    expect(DEC.decode(await materialize(out))).toBe('/x: image/png\n')
    expect(asked).toEqual([[0, 512]])
  })
})
